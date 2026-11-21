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
    public async Task FullOutboxDropsTheOldestInputAndNeverControlMessages()
    {
        // The send loop is not running yet, so nothing drains: this is a client that stopped reading.
        var wire = new MemoryStream();
        using var socket = WebSocket.CreateFromStream(wire, new WebSocketCreationOptions { IsServer = true });
        using var client = new ClientConnection(1, socket, "none", "test", NullLogger.Instance, CancellationToken.None);
        client.Send(Protocol.Hello("1.0.0", DeviceState.Attached));

        var results = new List<EnqueueResult>();
        for (var i = 0; i < 100; i++)
        {
            results.Add(client.SendInput(Input((byte)i)));
            if (i == 10)
            {
                client.Send(Protocol.Device(DeviceState.Attached));
            }
        }

        client.Send(Protocol.Device(DeviceState.Detached));
        client.Send(Protocol.DisplayError(9, "x"));

        Assert.All(results.Take(ClientConnection.MaxPendingInputs), r => Assert.Equal(EnqueueResult.Queued, r));
        Assert.All(results.Skip(ClientConnection.MaxPendingInputs), r => Assert.Equal(EnqueueResult.QueuedDroppedOldest, r));
        Assert.Equal(36, Interlocked.Read(ref client.InputsDropped));
        Assert.Equal(ClientConnection.MaxPendingInputs, client.PendingInputs);

        // Draining resumes input. The newest 64 inputs survive; control messages all go out, in their original order.
        var sendLoop = client.RunSendLoopAsync();
        await WaitUntilAsync(() => client.PendingInputs == 0);
        Assert.Equal(EnqueueResult.Queued, client.SendInput(Input(200)));
        client.Complete();
        await sendLoop;

        var sequence = ReadTextFrames(wire.ToArray()).Select(Describe).ToArray();
        string[] expected =
        [
            "hello",
            "device:attached",
            .. Enumerable.Range(36, ClientConnection.MaxPendingInputs).Select(i => $"input:{i}"),
            "device:detached",
            "display:error",
            "input:200",
        ];
        Assert.Equal(expected, sequence);
    }

    private static string Describe(JsonElement message)
    {
        var type = message.GetProperty("type").GetString()!;
        return type switch
        {
            "input" => $"input:{message.GetProperty("data")[0].GetInt32()}",
            "device" => $"device:{message.GetProperty("state").GetString()}",
            _ => type,
        };
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
