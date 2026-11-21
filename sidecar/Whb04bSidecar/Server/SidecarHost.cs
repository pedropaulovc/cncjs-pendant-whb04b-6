using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Whb04bSidecar.Devices;

namespace Whb04bSidecar.Server;

/// <summary>Thrown by <see cref="SidecarHost.StartAsync"/> when the port is taken (typically another sidecar).</summary>
internal sealed class PortInUseException(int port, Exception inner)
    : Exception($"Port {port} on 127.0.0.1 is already in use or reserved (is another sidecar running?). Use --port or \"port\" in settings.json to pick another.", inner)
{
    public int Port { get; } = port;
}

/// <summary>Kestrel on 127.0.0.1 serving /health, the /whb04b WebSocket and (simulated mode) /simulate/*.</summary>
internal sealed class SidecarHost : IAsyncDisposable
{
    public const string WebSocketPath = "/whb04b";

    private readonly WebApplication _app;
    private readonly SidecarOptions _options;
    private bool _started;

    private SidecarHost(WebApplication app, SidecarOptions options, IPendantDevice device, PendantHub hub)
    {
        _app = app;
        _options = options;
        Device = device;
        Hub = hub;
    }

    public IPendantDevice Device { get; }

    public PendantHub Hub { get; }

    /// <summary>The bound port (resolved after start when 0 was requested).</summary>
    public int Port { get; private set; }

    public static SidecarHost Create(SidecarOptions options, IPendantDevice device, ILoggerFactory loggerFactory)
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions
        {
            Args = [],
            ContentRootPath = AppContext.BaseDirectory,
            EnvironmentName = Environments.Production,
        });
        builder.Logging.ClearProviders();
        builder.Services.AddSingleton(loggerFactory);
        builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(3));
        builder.WebHost.ConfigureKestrel(kestrel =>
        {
            kestrel.AddServerHeader = false;
            kestrel.Listen(IPAddress.Loopback, options.Port);
        });

        var app = builder.Build();
        var hub = new PendantHub(device, options.Version, loggerFactory.CreateLogger<PendantHub>());
        var policy = new OriginPolicy(options.AllowedOrigins);
        var log = loggerFactory.CreateLogger<SidecarHost>();

        app.Use((context, next) => ApplyOriginPolicy(context, next, policy, log));
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) });

        app.MapGet("/health", () =>
        {
            var status = hub.Status;
            return Results.Json(new HealthResponse(Protocol.Version, options.Version, Protocol.StateName(status.Device), status.Clients, options.ModeName));
        });

        app.Map(WebSocketPath, async context =>
        {
            if (!context.WebSockets.IsWebSocketRequest)
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                await context.Response.WriteAsync("WebSocket upgrade required");
                return;
            }

            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            var remote = $"{context.Connection.RemoteIpAddress}:{context.Connection.RemotePort}";
            await hub.RunClientAsync(socket, context.Request.Headers.Origin.ToString(), remote, context.RequestAborted);
        });

        if (device is SimulatedPendantDevice simulated)
        {
            MapSimulationEndpoints(app, simulated);
        }

        app.Lifetime.ApplicationStopping.Register(hub.Shutdown);
        return new SidecarHost(app, options, device, hub);
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            await _app.StartAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (IOException ex) when (ex.InnerException is AddressInUseException || ex.InnerException is SocketException { SocketErrorCode: SocketError.AddressAlreadyInUse or SocketError.AccessDenied })
        {
            throw new PortInUseException(_options.Port, ex);
        }

        _started = true;
        var addresses = _app.Services.GetRequiredService<IServer>().Features.GetRequiredFeature<IServerAddressesFeature>().Addresses;
        Port = new Uri(addresses.First()).Port;
        Device.Start();
    }

    public async Task StopAsync()
    {
        if (_started)
        {
            _started = false;
            await _app.StopAsync().ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
        Hub.Dispose();
        await Device.DisposeAsync().ConfigureAwait(false);
        await _app.DisposeAsync().ConfigureAwait(false);
    }

    private static Task ApplyOriginPolicy(HttpContext context, RequestDelegate next, OriginPolicy policy, ILogger log)
    {
        var origins = context.Request.Headers.Origin;
        var origin = origins.Count == 1 ? origins[0] : null;
        if (origins.Count > 1 || !policy.IsAllowed(origin))
        {
            log.LogWarning("Rejected {Method} {Path} from origin {Origin} (403)", context.Request.Method, context.Request.Path, origins.ToString());
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        }

        if (string.IsNullOrEmpty(origin))
        {
            return next(context);
        }

        // Allowed browser origins may read /health (and drive /simulate/*) with fetch().
        var headers = context.Response.Headers;
        headers.AccessControlAllowOrigin = origin;
        headers.Vary = "Origin";
        if (!HttpMethods.IsOptions(context.Request.Method))
        {
            return next(context);
        }

        headers.AccessControlAllowMethods = "GET, POST";
        headers.AccessControlAllowHeaders = "Content-Type";
        headers["Access-Control-Allow-Private-Network"] = "true";
        context.Response.StatusCode = StatusCodes.Status204NoContent;
        return Task.CompletedTask;
    }

    private static void MapSimulationEndpoints(WebApplication app, SimulatedPendantDevice device)
    {
        app.MapPost("/simulate/input", async (HttpRequest request) =>
        {
            byte[] data;
            try
            {
                using var body = await JsonDocument.ParseAsync(request.Body);
                if (body.RootElement.ValueKind != JsonValueKind.Object
                    || !Protocol.TryReadBytes(body.RootElement, "data", SimulatedPendantDevice.InputBodyLength, out data))
                {
                    return Results.BadRequest(new { error = $"body must be {{\"data\":[{SimulatedPendantDevice.InputBodyLength} integers 0-255]}}" });
                }
            }
            catch (JsonException)
            {
                return Results.BadRequest(new { error = "invalid JSON" });
            }

            return device.InjectInput(data)
                ? Results.Ok(new { relayed = true })
                : Results.Conflict(new { error = "simulated device is detached" });
        });

        app.MapPost("/simulate/detach", () =>
        {
            device.Detach();
            return Results.Ok(new { device = Protocol.StateName(device.State) });
        });

        app.MapPost("/simulate/attach", () =>
        {
            device.Attach();
            return Results.Ok(new { device = Protocol.StateName(device.State) });
        });

        app.MapGet("/simulate/display", () =>
            Results.Json(new { frames = device.RecentFrames().Select(frame => frame.Select(b => (int)b).ToArray()).ToArray() }));
    }

    private sealed record HealthResponse(int Protocol, string Version, string Device, int Clients, string Mode);
}
