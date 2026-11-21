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
using Microsoft.Extensions.Primitives;
using Whb04bSidecar.Devices;

namespace Whb04bSidecar.Server;

/// <summary>Thrown by <see cref="SidecarHost.StartAsync"/> when the port is taken (typically another sidecar) or reserved.</summary>
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
    private HostState _state = HostState.Created;

    private SidecarHost(WebApplication app, SidecarOptions options, IPendantDevice device, PendantHub hub)
    {
        _app = app;
        _options = options;
        Device = device;
        Hub = hub;
    }

    private enum HostState
    {
        Created,
        Started,
        Stopped,
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
        var rejections = new OriginRejections(loggerFactory.CreateLogger<OriginRejections>());

        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) });
        app.Use((context, next) => ApplyOriginPolicy(context, next, policy, rejections));

        app.MapGet("/health", () =>
        {
            var status = hub.Status;
            return Results.Json(new HealthResponse(
                Protocol.Version,
                options.Version,
                Protocol.StateName(status.Device),
                status.Clients,
                options.ModeName,
                Protocol.LcdName(status.Lcd)));
        });

        app.Map(WebSocketPath, async context =>
        {
            if (!context.WebSockets.IsWebSocketRequest)
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                await context.Response.WriteAsync("WebSocket upgrade required");
                return;
            }

            var origins = context.Request.Headers.Origin;
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            if (Classify(policy, origins) != OriginVerdict.Allowed)
            {
                // Only local-network-looking origins get here (the middleware 403s the rest). Accepted only so the
                // widget can read the 4403 reason; it never reaches the hub, so it cannot become owner or supersede.
                rejections.Log(origins.ToString(), "WebSocket upgrade (closed 4403)");
                await OriginRejections.CloseWebSocketAsync(socket, origins.ToString(), context.RequestAborted);
                return;
            }

            var remote = $"{context.Connection.RemoteIpAddress}:{context.Connection.RemotePort}";
            await hub.RunClientAsync(socket, origins.ToString(), remote, context.RequestAborted);
        });

        if (device is SimulatedPendantDevice simulated)
        {
            MapSimulationEndpoints(app, simulated);
        }

        app.Lifetime.ApplicationStopping.Register(hub.Shutdown);
        return new SidecarHost(app, options, device, hub);
    }

    /// <summary>Bind failures that mean "pick another port": in use (WSAEADDRINUSE) or excluded/reserved (WSAEACCES).</summary>
    public static bool IsPortUnavailable(Exception exception)
    {
        var cause = exception is IOException { InnerException: { } inner } ? inner : exception;
        return cause switch
        {
            AddressInUseException => true,
            SocketException { SocketErrorCode: SocketError.AddressAlreadyInUse or SocketError.AccessDenied } => true,
            _ => false,
        };
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            await _app.StartAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (IsPortUnavailable(ex))
        {
            throw new PortInUseException(_options.Port, ex);
        }

        _state = HostState.Started;
        var addresses = _app.Services.GetRequiredService<IServer>().Features.GetRequiredFeature<IServerAddressesFeature>().Addresses;
        Port = new Uri(addresses.First()).Port;
        Device.Start();
    }

    public async Task StopAsync()
    {
        if (_state != HostState.Started)
        {
            return;
        }

        _state = HostState.Stopped;
        await _app.StopAsync().ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
        Hub.Dispose();
        await Device.DisposeAsync().ConfigureAwait(false);
        await _app.DisposeAsync().ConfigureAwait(false);
    }

    private static OriginVerdict Classify(OriginPolicy policy, StringValues origins) =>
        origins.Count <= 1 ? policy.Classify(origins.Count == 1 ? origins[0] : null) : OriginVerdict.Denied;

    private static Task ApplyOriginPolicy(HttpContext context, RequestDelegate next, OriginPolicy policy, OriginRejections rejections)
    {
        var origins = context.Request.Headers.Origin;
        var verdict = Classify(policy, origins);
        // A local-network CNCjs page gets its WebSocket accepted and closed with 4403 by the endpoint, so the widget
        // can explain the fix. Everything else not allowed gets a plain 403, so public pages cannot fingerprint us.
        if (verdict == OriginVerdict.DeniedLocalNetwork && context.WebSockets.IsWebSocketRequest && context.Request.Path == WebSocketPath)
        {
            return next(context);
        }

        if (verdict != OriginVerdict.Allowed)
        {
            rejections.Log(origins.ToString(), $"{context.Request.Method} {context.Request.Path} (403)");
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        }

        var origin = origins.ToString();
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
            byte[] body;
            try
            {
                using var json = await JsonDocument.ParseAsync(request.Body);
                if (json.RootElement.ValueKind != JsonValueKind.Object
                    || !Protocol.TryReadBytes(json.RootElement, "data", PendantDevice.InputBodyLength, out body))
                {
                    return Results.BadRequest(new { error = $"body must be {{\"data\":[{PendantDevice.InputBodyLength} integers 0-255]}}" });
                }
            }
            catch (JsonException)
            {
                return Results.BadRequest(new { error = "invalid JSON" });
            }

            return device.InjectInput(body) switch
            {
                InjectResult.Relayed => Results.Ok(new { relayed = true }),
                _ => Results.Conflict(new { error = "simulated device is detached" }),
            };
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

    private sealed record HealthResponse(int Protocol, string Version, string Device, int Clients, string Mode, string Lcd);
}
