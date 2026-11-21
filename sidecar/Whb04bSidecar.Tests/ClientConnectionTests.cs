using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Whb04bSidecar.Devices;
using Whb04bSidecar.Server;

namespace Whb04bSidecar.Tests;

public sealed class ClientConnectionTests
{
    [Fact]
    public async Task InputBeyondTheOutboxBoundIsDroppedButControlMessagesAreNot()
    {
        // The send loop is not running yet, so nothing drains: this is a client that stopped reading.
        var wire = new MemoryStream();
        using var socket = WebSocket.CreateFromStream(wire, new WebSocketCreationOptions { IsServer = true });
        using var client = new ClientConnection(1, socket, "none", "test", NullLogger.Instance, CancellationToken.None);
        client.Send(Protocol.Hello("1.0.0", DeviceState.Attached));

        var results = Enumerable.Range(0, 100).Select(i => client.SendInput(Input((byte)i))).ToArray();
        client.Send(Protocol.Device(DeviceState.Detached));
        client.Send(Protocol.DisplayError(9, "x"));

        Assert.Equal(ClientConnection.MaxPendingInputs, results.Count(r => r == EnqueueResult.Queued));
        Assert.All(results.Skip(ClientConnection.MaxPendingInputs), r => Assert.Equal(EnqueueResult.DroppedOutboxFull, r));
        Assert.Equal(36, Interlocked.Read(ref client.InputsDropped));
        Assert.Equal(ClientConnection.MaxPendingInputs, client.PendingInputs);

        // Draining resumes input; every control message and the 64 oldest inputs go out in order.
        var sendLoop = client.RunSendLoopAsync();
        await WaitUntilAsync(() => client.PendingInputs == 0);
        Assert.Equal(EnqueueResult.Queued, client.SendInput(Input(200)));
        client.Complete();
        await sendLoop;

        var messages = ReadTextFrames(wire.ToArray());
        Assert.Equal("hello", messages[0].GetProperty("type").GetString());
        var inputs = messages.Where(m => m.GetProperty("type").GetString() == "input").Select(m => m.GetProperty("data")[0].GetInt32()).ToArray();
        Assert.Equal([.. Enumerable.Range(0, ClientConnection.MaxPendingInputs), 200], inputs);
        Assert.Contains(messages, m => m.GetProperty("type").GetString() == "device");
        Assert.Contains(messages, m => m.GetProperty("type").GetString() == "display:error");
    }

    private static byte[] Input(byte marker) => Protocol.Input(new PendantInputReport(4, [marker, 0, 0, 0, 0, 0, 0], 1));

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "condition not met within 5 s");
            await Task.Delay(10);
        }
    }

    /// <summary>Decodes unmasked server→client text frames (all short, single-frame, 7- or 16-bit lengths).</summary>
    private static List<JsonElement> ReadTextFrames(byte[] bytes)
    {
        var messages = new List<JsonElement>();
        var offset = 0;
        while (offset < bytes.Length)
        {
            var length = bytes[offset + 1] & 0x7F;
            var header = 2;
            if (length == 126)
            {
                length = (bytes[offset + 2] << 8) | bytes[offset + 3];
                header = 4;
            }

            var text = Encoding.UTF8.GetString(bytes, offset + header, length);
            messages.Add(JsonDocument.Parse(text).RootElement.Clone());
            offset += header + length;
        }

        return messages;
    }
}
