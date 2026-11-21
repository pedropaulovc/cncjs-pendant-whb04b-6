using System.Net.WebSockets;
using Whb04bSidecar.Devices;
using static Whb04bSidecar.Tests.SidecarTestServer;

namespace Whb04bSidecar.Tests;

public sealed class WebSocketProtocolTests
{
    private static readonly byte[] Frame = Enumerable.Range(0, 21).Select(i => (byte)(i * 12 + 3)).ToArray();

    [Fact]
    public async Task HelloIsTheFirstMessage()
    {
        await using var server = await StartFakeAsync();
        using var socket = await server.ConnectAsync();

        var hello = await ReceiveJsonAsync(socket);

        Assert.Equal("hello", hello.GetProperty("type").GetString());
        Assert.Equal(1, hello.GetProperty("protocol").GetInt32());
        Assert.Equal(TestVersion, hello.GetProperty("version").GetString());
        Assert.Equal("attached", hello.GetProperty("device").GetString());
    }

    [Fact]
    public async Task HelloReportsDetachedDevice()
    {
        await using var server = await StartFakeAsync();
        server.Fake.Detach();
        using var socket = await server.ConnectAsync();

        var hello = await ReceiveJsonAsync(socket);

        Assert.Equal("detached", hello.GetProperty("device").GetString());
    }

    [Fact]
    public async Task InputReportsAreRelayedByteExactWithoutDedupe()
    {
        await using var server = await StartFakeAsync();
        using var socket = await server.ConnectOwnerAsync();
        byte[] body = [0x9C, 0x01, 0x00, 0x11, 0x06, 0xFF, 0x7E];

        server.Fake.EmitInput(4, body);
        server.Fake.EmitInput(4, body);

        foreach (var _ in Enumerable.Range(0, 2))
        {
            var input = await ReceiveJsonAsync(socket);
            Assert.Equal("input", input.GetProperty("type").GetString());
            Assert.Equal(4, input.GetProperty("reportId").GetInt32());
            Assert.Equal(body, Bytes(input.GetProperty("data")));
        }
    }

    [Fact]
    public async Task DisplayFrameIsWrittenAsThreeFeatureReportsAndAcked()
    {
        await using var server = await StartFakeAsync();
        using var socket = await server.ConnectOwnerAsync();

        await SendJsonAsync(socket, new { type = "display", id = 42u, frame = Frame.Select(b => (int)b) });
        var ack = await ReceiveJsonAsync(socket);

        Assert.Equal("display:ack", ack.GetProperty("type").GetString());
        Assert.Equal(42u, ack.GetProperty("id").GetUInt32());
        var reports = server.Fake.FeatureReports.ToArray();
        Assert.Equal(3, reports.Length);
        for (var chunk = 0; chunk < 3; chunk++)
        {
            Assert.Equal(8, reports[chunk].Length);
            Assert.Equal(0x06, reports[chunk][0]);
            Assert.Equal(Frame.Skip(chunk * 7).Take(7), reports[chunk].Skip(1));
        }
    }

    [Fact]
    public async Task FramesAreWrittenInArrivalOrder()
    {
        await using var server = await StartFakeAsync();
        using var socket = await server.ConnectOwnerAsync();
        var frames = Enumerable.Range(1, 5).Select(n => Enumerable.Repeat((byte)n, 21).ToArray()).ToArray();

        for (var i = 0; i < frames.Length; i++)
        {
            await SendJsonAsync(socket, new { type = "display", id = i, frame = frames[i].Select(b => (int)b) });
        }

        for (var i = 0; i < frames.Length; i++)
        {
            var ack = await ReceiveJsonAsync(socket);
            Assert.Equal(i, ack.GetProperty("id").GetInt32());
        }

        var reports = server.Fake.FeatureReports.ToArray();
        Assert.Equal(15, reports.Length);
        Assert.Equal(frames.SelectMany(f => f), reports.SelectMany(r => r.Skip(1)));
    }

    [Fact]
    public async Task ChunkTimeoutRepliesDisplayErrorAndResetsDevice()
    {
        await using var server = await StartFakeAsync(TimeSpan.FromMilliseconds(200));
        using var socket = await server.ConnectOwnerAsync();
        server.Fake.HangWrites = true;

        await SendJsonAsync(socket, new { type = "display", id = 7, frame = Frame.Select(b => (int)b) });
        var messages = new[] { await ReceiveJsonAsync(socket), await ReceiveJsonAsync(socket), await ReceiveJsonAsync(socket) };

        var error = Assert.Single(messages, m => m.GetProperty("type").GetString() == "display:error");
        Assert.Equal(7, error.GetProperty("id").GetInt32());
        Assert.Contains("timed out", error.GetProperty("message").GetString());
        var states = messages.Where(m => m.GetProperty("type").GetString() == "device").Select(m => m.GetProperty("state").GetString());
        Assert.Equal(["detached", "attached"], states);
        Assert.Equal(1, server.Fake.Resets);
        server.Fake.ReleaseHang();

        // The device recovered: the next frame goes through.
        await SendJsonAsync(socket, new { type = "display", id = 8, frame = Frame.Select(b => (int)b) });
        var ack = await ReceiveJsonAsync(socket);
        Assert.Equal("display:ack", ack.GetProperty("type").GetString());
        Assert.Equal(8, ack.GetProperty("id").GetInt32());
        Assert.Contains("LCD frame 7 from client #1 failed", server.ReadLog());
    }

    [Fact]
    public async Task DisplayWithoutDeviceRepliesError()
    {
        await using var server = await StartFakeAsync();
        using var socket = await server.ConnectOwnerAsync();
        server.Fake.Detach();
        var detached = await ReceiveJsonAsync(socket);
        Assert.Equal("device", detached.GetProperty("type").GetString());
        Assert.Equal("detached", detached.GetProperty("state").GetString());

        await SendJsonAsync(socket, new { type = "display", id = 3, frame = Frame.Select(b => (int)b) });
        var error = await ReceiveJsonAsync(socket);

        Assert.Equal("display:error", error.GetProperty("type").GetString());
        Assert.Equal(3, error.GetProperty("id").GetInt32());
        Assert.Empty(server.Fake.FeatureReports);
    }

    [Fact]
    public async Task DeviceTransitionsAreSentToTheOwner()
    {
        await using var server = await StartFakeAsync();
        using var socket = await server.ConnectOwnerAsync();

        server.Fake.Detach();
        server.Fake.Attach();

        Assert.Equal("detached", (await ReceiveJsonAsync(socket)).GetProperty("state").GetString());
        Assert.Equal("attached", (await ReceiveJsonAsync(socket)).GetProperty("state").GetString());
    }

    [Fact]
    public async Task NewestConnectionSupersedesThePreviousOwner()
    {
        await using var server = await StartFakeAsync();
        using var first = await server.ConnectOwnerAsync();
        using var second = await server.ConnectAsync();

        var hello = await ReceiveJsonAsync(second);
        var (status, before) = await ReceiveCloseAsync(first);

        Assert.Equal("hello", hello.GetProperty("type").GetString());
        Assert.Equal(4001, status);
        var superseded = Assert.Single(before);
        Assert.Equal("superseded", superseded.GetProperty("type").GetString());

        server.Fake.EmitInput(4, 1, 2, 3, 4, 5, 6, 7);
        var input = await ReceiveJsonAsync(second);
        Assert.Equal("input", input.GetProperty("type").GetString());

        var log = server.ReadLog();
        Assert.Contains("Client #1 connected from origin none", log);
        Assert.Contains("Client #1 (none) superseded by client #2", log);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[1,2,3]")]
    [InlineData("{\"id\":1}")]
    [InlineData("{\"type\":\"jog\"}")]
    [InlineData("{\"type\":\"display\",\"id\":-1,\"frame\":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}")]
    [InlineData("{\"type\":\"display\",\"id\":1,\"frame\":[0,0,0]}")]
    [InlineData("{\"type\":\"display\",\"id\":1,\"frame\":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,256]}")]
    [InlineData("{\"type\":\"display\",\"id\":1,\"frame\":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1.5]}")]
    public async Task MalformedMessageClosesWith4400(string payload)
    {
        await using var server = await StartFakeAsync();
        using var socket = await server.ConnectOwnerAsync();

        await SendTextAsync(socket, payload);
        var (status, _) = await ReceiveCloseAsync(socket);

        Assert.Equal(4400, status);
        Assert.False(string.IsNullOrEmpty(socket.CloseStatusDescription));
        Assert.Empty(server.Fake.FeatureReports);
    }

    [Fact]
    public async Task BinaryMessageClosesWith4400()
    {
        await using var server = await StartFakeAsync();
        using var socket = await server.ConnectOwnerAsync();

        await socket.SendAsync(new byte[] { 1, 2, 3 }, WebSocketMessageType.Binary, true, CancellationToken.None);
        var (status, _) = await ReceiveCloseAsync(socket);

        Assert.Equal(4400, status);
    }

    [Fact]
    public async Task ClientCloseIsAnsweredAndClientCountDrops()
    {
        await using var server = await StartFakeAsync();
        using var socket = await server.ConnectOwnerAsync();

        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);

        Assert.Equal(WebSocketState.Closed, socket.State);
        await WaitForAsync(async () => (await HealthAsync(server)).GetProperty("clients").GetInt32() == 0);
    }

    internal static async Task<System.Text.Json.JsonElement> HealthAsync(SidecarTestServer server)
    {
        var json = await server.Http.GetStringAsync("/health");
        return System.Text.Json.JsonDocument.Parse(json).RootElement.Clone();
    }

    internal static async Task WaitForAsync(Func<Task<bool>> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!await condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "condition not met within 5 s");
            await Task.Delay(25);
        }
    }
}
