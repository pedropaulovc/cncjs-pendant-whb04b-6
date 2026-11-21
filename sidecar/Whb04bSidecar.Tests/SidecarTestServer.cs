using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Whb04bSidecar.Devices;
using Whb04bSidecar.Logging;
using Whb04bSidecar.Server;

namespace Whb04bSidecar.Tests;

/// <summary>Real Kestrel sidecar on an ephemeral loopback port, backed by a fake or simulated device.</summary>
internal sealed class SidecarTestServer : IAsyncDisposable
{
    public const string TestVersion = "9.8.7-test";
    private static readonly TimeSpan ReceiveTimeout = TimeSpan.FromSeconds(5);

    private readonly SidecarHost _host;
    private readonly ILoggerFactory _loggerFactory;
    private readonly string _logDirectory;

    private SidecarTestServer(SidecarHost host, IPendantDevice device, ILoggerFactory loggerFactory, string logDirectory)
    {
        _host = host;
        _loggerFactory = loggerFactory;
        _logDirectory = logDirectory;
        Device = device;
        Http = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{host.Port}") };
    }

    public IPendantDevice Device { get; }

    public FakePendantDevice Fake => (FakePendantDevice)Device;

    public SimulatedPendantDevice Simulated => (SimulatedPendantDevice)Device;

    public HttpClient Http { get; }

    public int Port => _host.Port;

    public Uri WebSocketUri => new($"ws://127.0.0.1:{_host.Port}{SidecarHost.WebSocketPath}");

    public static Task<SidecarTestServer> StartFakeAsync(TimeSpan? chunkTimeout = null, params string[] allowedOrigins) =>
        StartAsync(new FakePendantDevice(chunkTimeout), SidecarMode.Hid, allowedOrigins);

    public static Task<SidecarTestServer> StartSimulatedAsync() =>
        StartAsync(new SimulatedPendantDevice(NullLogger<SimulatedPendantDevice>.Instance), SidecarMode.Simulated, []);

    /// <summary>Logs go to a per-server temp folder at Trace level, so every log template and the file sink are exercised.</summary>
    private static async Task<SidecarTestServer> StartAsync(IPendantDevice device, SidecarMode mode, string[] allowedOrigins)
    {
        var logDirectory = Path.Combine(Path.GetTempPath(), "whb04b-sidecar-tests", Guid.NewGuid().ToString("N"));
        var loggerFactory = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Trace).AddProvider(new FileLoggerProvider(logDirectory)));
        var options = new SidecarOptions(0, allowedOrigins, mode, TestVersion);
        var host = SidecarHost.Create(options, device, loggerFactory);
        await host.StartAsync();
        return new SidecarTestServer(host, device, loggerFactory, logDirectory);
    }

    public string ReadLog() =>
        string.Concat(Directory.EnumerateFiles(_logDirectory).Select(path =>
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return new StreamReader(stream).ReadToEnd();
        }));

    public async Task<ClientWebSocket> ConnectAsync(string? origin = null)
    {
        var socket = new ClientWebSocket();
        if (origin is not null)
        {
            socket.Options.SetRequestHeader("Origin", origin);
        }

        await socket.ConnectAsync(WebSocketUri, CancellationToken.None);
        return socket;
    }

    /// <summary>Connects and consumes the hello message, asserting its shape.</summary>
    public async Task<ClientWebSocket> ConnectOwnerAsync()
    {
        var socket = await ConnectAsync();
        var hello = await ReceiveJsonAsync(socket);
        Assert.Equal("hello", hello.GetProperty("type").GetString());
        return socket;
    }

    public async ValueTask DisposeAsync()
    {
        Http.Dispose();
        await _host.DisposeAsync();
        _loggerFactory.Dispose();
        if (Directory.Exists(_logDirectory))
        {
            Directory.Delete(_logDirectory, recursive: true);
        }
    }

    public static Task SendJsonAsync(ClientWebSocket socket, object message) =>
        SendTextAsync(socket, JsonSerializer.Serialize(message));

    public static Task SendTextAsync(ClientWebSocket socket, string text) =>
        socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

    public static async Task<JsonElement> ReceiveJsonAsync(ClientWebSocket socket)
    {
        var (type, text) = await ReceiveAsync(socket);
        Assert.Equal(WebSocketMessageType.Text, type);
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    /// <summary>Reads until the server's close frame; returns the close status, collecting any text messages before it.</summary>
    public static async Task<(int Status, List<JsonElement> Before)> ReceiveCloseAsync(ClientWebSocket socket)
    {
        var before = new List<JsonElement>();
        while (true)
        {
            var (type, text) = await ReceiveAsync(socket);
            if (type == WebSocketMessageType.Close)
            {
                return ((int)socket.CloseStatus!.Value, before);
            }

            before.Add(JsonDocument.Parse(text).RootElement.Clone());
        }
    }

    public static byte[] Bytes(JsonElement array) => array.EnumerateArray().Select(e => (byte)e.GetInt32()).ToArray();

    private static async Task<(WebSocketMessageType Type, string Text)> ReceiveAsync(ClientWebSocket socket)
    {
        using var timeout = new CancellationTokenSource(ReceiveTimeout);
        var buffer = new byte[8192];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, timeout.Token);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return (result.MessageType, "");
            }

            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                return (result.MessageType, Encoding.UTF8.GetString(message.ToArray()));
            }
        }
    }
}
