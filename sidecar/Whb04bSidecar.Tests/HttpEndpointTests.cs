using System.Net;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Whb04bSidecar.Server;
using static Whb04bSidecar.Tests.SidecarTestServer;
using static Whb04bSidecar.Tests.WebSocketProtocolTests;

namespace Whb04bSidecar.Tests;

public sealed class HttpEndpointTests
{
    [Fact]
    public async Task SecondHostOnTheSamePortReportsPortInUse()
    {
        await using var server = await StartFakeAsync();
        var options = new SidecarOptions(server.Port, [], SidecarMode.Hid, TestVersion);
        await using var second = SidecarHost.Create(options, new FakePendantDevice(), NullLoggerFactory.Instance);

        var error = await Assert.ThrowsAsync<PortInUseException>(() => second.StartAsync());

        Assert.Equal(server.Port, error.Port);
        Assert.Equal(HttpStatusCode.OK, (await server.Http.GetAsync("/health")).StatusCode);
    }

    [Fact]
    public async Task HealthReportsProtocolVersionDeviceClientsAndMode()
    {
        await using var server = await StartFakeAsync();

        var idle = await HealthAsync(server);
        Assert.Equal(1, idle.GetProperty("protocol").GetInt32());
        Assert.Equal(TestVersion, idle.GetProperty("version").GetString());
        Assert.Equal("attached", idle.GetProperty("device").GetString());
        Assert.Equal(0, idle.GetProperty("clients").GetInt32());
        Assert.Equal("hid", idle.GetProperty("mode").GetString());
        Assert.Equal("ok", idle.GetProperty("lcd").GetString());

        using var socket = await server.ConnectOwnerAsync();
        server.Fake.Detach();
        var busy = await HealthAsync(server);
        Assert.Equal(1, busy.GetProperty("clients").GetInt32());
        Assert.Equal("detached", busy.GetProperty("device").GetString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("http://localhost:8000")]
    [InlineData("http://localhost")]
    [InlineData("https://localhost:8443")]
    [InlineData("http://127.0.0.1:8000")]
    [InlineData("http://[::1]:8000")]
    public async Task LoopbackAndMissingOriginsAreAllowed(string? origin)
    {
        await using var server = await StartFakeAsync();

        using var response = await GetHealthAsync(server, origin);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        if (origin is not null)
        {
            Assert.Equal(origin, response.Headers.GetValues("Access-Control-Allow-Origin").Single());
        }

        using var socket = await server.ConnectAsync(origin);
        Assert.Equal("hello", (await ReceiveJsonAsync(socket)).GetProperty("type").GetString());
    }

    [Theory]
    [InlineData("http://evil.example")]
    [InlineData("https://example.com")]
    [InlineData("http://localhost.evil.example")]
    [InlineData("http://8.8.8.8")]
    [InlineData("http://172.32.0.1")]
    [InlineData("null")]
    [InlineData("file://")]
    [InlineData("chrome-extension://abcdef")]
    public async Task PublicOriginsGetPlain403WithNoUpgrade(string origin)
    {
        await using var server = await StartFakeAsync();

        using var response = await GetHealthAsync(server, origin);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Origin", origin);
        socket.Options.CollectHttpResponseDetails = true;
        await Assert.ThrowsAsync<WebSocketException>(() => socket.ConnectAsync(server.WebSocketUri, CancellationToken.None));
        Assert.Equal(HttpStatusCode.Forbidden, socket.HttpStatusCode);
    }

    [Theory]
    [InlineData("http://192.168.1.50:8000")]
    [InlineData("http://10.0.0.2")]
    [InlineData("http://[fd12:3456::1]:8000")]
    [InlineData("http://raspberrypi:8000")]
    [InlineData("http://cnc.local")]
    [InlineData("https://shop.home.arpa")]
    public async Task LocalNetworkOriginsGet403OnHttpAnd4403OnWebSocket(string origin)
    {
        await using var server = await StartFakeAsync();

        using var response = await GetHealthAsync(server, origin);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);

        using var socket = await server.ConnectAsync(origin);
        var (status, before) = await ReceiveCloseAsync(socket);
        Assert.Equal(4403, status);
        Assert.Empty(before);
        Assert.Equal($"origin not allowed: {origin}", socket.CloseStatusDescription);
        await WaitForAsync(async () => (await HealthAsync(server)).GetProperty("clients").GetInt32() == 0);
    }

    [Fact]
    public async Task RejectedOriginNeverSupersedesTheOwnerAndWarnsOnce()
    {
        await using var server = await StartFakeAsync();
        using var owner = await server.ConnectOwnerAsync();

        for (var attempt = 0; attempt < 3; attempt++)
        {
            using var intruder = await server.ConnectAsync("http://192.168.1.50:8000");
            Assert.Equal(4403, (await ReceiveCloseAsync(intruder)).Status);
        }

        Assert.Equal(WebSocketState.Open, owner.State);
        Assert.Equal(1, (await HealthAsync(server)).GetProperty("clients").GetInt32());
        server.Fake.EmitInput(1, 2, 3, 4, 5, 6, 7);
        Assert.Equal("input", (await ReceiveJsonAsync(owner)).GetProperty("type").GetString());
        var warnings = server.ReadLog().Split('\n').Count(line => line.Contains(" WRN ") && line.Contains("origin http://192.168.1.50:8000"));
        Assert.Equal(1, warnings);
    }

    [Fact]
    public async Task ConfiguredExtraOriginIsAllowed()
    {
        await using var server = await StartFakeAsync(null, "http://cnc.lan:8000");

        using var allowed = await GetHealthAsync(server, "http://cnc.lan:8000");
        using var otherPort = await GetHealthAsync(server, "http://cnc.lan:9000");

        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, otherPort.StatusCode);
    }

    [Fact]
    public async Task PreflightFromAllowedOriginSucceeds()
    {
        await using var server = await StartSimulatedAsync();
        using var request = new HttpRequestMessage(HttpMethod.Options, "/simulate/input");
        request.Headers.Add("Origin", "http://localhost:8000");
        request.Headers.Add("Access-Control-Request-Method", "POST");

        using var response = await server.Http.SendAsync(request);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("http://localhost:8000", response.Headers.GetValues("Access-Control-Allow-Origin").Single());
    }

    [Fact]
    public async Task NonWebSocketRequestToSocketPathIs400()
    {
        await using var server = await StartFakeAsync();

        using var response = await server.Http.GetAsync("/whb04b");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task SimulationEndpointsDoNotExistInHidMode()
    {
        await using var server = await StartFakeAsync();

        using var input = await server.Http.PostAsJsonAsync("/simulate/input", new { data = new[] { 1, 2, 3, 4, 5, 6, 7 } });
        using var display = await server.Http.GetAsync("/simulate/display");

        Assert.Equal(HttpStatusCode.NotFound, input.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, display.StatusCode);
    }

    [Fact]
    public async Task SimulatedModeRelaysInjectedInput()
    {
        await using var server = await StartSimulatedAsync();
        Assert.Equal("simulated", (await HealthAsync(server)).GetProperty("mode").GetString());
        using var socket = await server.ConnectOwnerAsync();
        int[] body = [17, 0x0C, 0, 0x0D, 0x11, 0xFE, 99];

        using var response = await server.Http.PostAsJsonAsync("/simulate/input", new { data = body });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var input = await ReceiveJsonAsync(socket);
        Assert.Equal("input", input.GetProperty("type").GetString());
        Assert.Equal(4, input.GetProperty("reportId").GetInt32());
        Assert.Equal(body.Select(b => (byte)b), Bytes(input.GetProperty("data")));
        AssertFreshTimestamp(input);
    }

    [Theory]
    [InlineData("{\"data\":[1,2,3]}")]
    [InlineData("{\"data\":[1,2,3,4,5,6,300]}")]
    [InlineData("[1,2,3,4,5,6,7]")]
    [InlineData("nope")]
    public async Task SimulatedInputRejectsBadBodies(string body)
    {
        await using var server = await StartSimulatedAsync();

        using var response = await server.Http.PostAsync("/simulate/input", new StringContent(body, System.Text.Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task SimulatedDetachAndAttachAreBroadcast()
    {
        await using var server = await StartSimulatedAsync();
        using var socket = await server.ConnectOwnerAsync();

        using var detach = await server.Http.PostAsync("/simulate/detach", null);
        Assert.Equal("detached", (await ReceiveJsonAsync(socket)).GetProperty("state").GetString());
        Assert.Equal("detached", (await HealthAsync(server)).GetProperty("device").GetString());

        using var rejected = await server.Http.PostAsJsonAsync("/simulate/input", new { data = new[] { 1, 2, 3, 4, 5, 6, 7 } });
        Assert.Equal(HttpStatusCode.Conflict, rejected.StatusCode);

        using var attach = await server.Http.PostAsync("/simulate/attach", null);
        Assert.Equal("attached", (await ReceiveJsonAsync(socket)).GetProperty("state").GetString());
        Assert.Equal("attached", (await HealthAsync(server)).GetProperty("device").GetString());
    }

    [Fact]
    public async Task SimulatedDisplayKeepsTheLastFiftyFrames()
    {
        await using var server = await StartSimulatedAsync();
        using var socket = await server.ConnectOwnerAsync();

        for (var i = 0; i < 55; i++)
        {
            await SendJsonAsync(socket, new { type = "display", id = i, frame = Enumerable.Repeat(i, 21) });
            Assert.Equal("display:ack", (await ReceiveJsonAsync(socket)).GetProperty("type").GetString());
        }

        var json = JsonDocument.Parse(await server.Http.GetStringAsync("/simulate/display")).RootElement;
        var frames = json.GetProperty("frames").EnumerateArray().Select(Bytes).ToArray();
        Assert.Equal(50, frames.Length);
        Assert.All(frames, f => Assert.Equal(21, f.Length));
        Assert.Equal(5, frames[0][0]);
        Assert.Equal(54, frames[^1][20]);
    }

    private static Task<HttpResponseMessage> GetHealthAsync(SidecarTestServer server, string? origin)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/health");
        if (origin is not null)
        {
            request.Headers.TryAddWithoutValidation("Origin", origin);
        }

        return server.Http.SendAsync(request);
    }
}
