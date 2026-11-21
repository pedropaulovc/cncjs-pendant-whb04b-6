using System.Buffers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Whb04bSidecar.Devices;

namespace Whb04bSidecar.Server;

/// <summary>A client <c>display</c> request: LCD frame <see cref="Id"/> with its 21-byte payload.</summary>
internal readonly record struct DisplayRequest(uint Id, byte[] Frame);

/// <summary>Wire format of protocol v1 (see sidecar-protocol.md): builds server messages, validates client messages.</summary>
internal static class Protocol
{
    public const int Version = 1;
    public const WebSocketCloseStatus SupersededCloseStatus = (WebSocketCloseStatus)4001;
    public const WebSocketCloseStatus MalformedCloseStatus = (WebSocketCloseStatus)4400;
    public const WebSocketCloseStatus OriginRejectedCloseStatus = (WebSocketCloseStatus)4403;
    private const int MaxCloseReasonBytes = 123;

    public static string StateName(DeviceState state) => state == DeviceState.Attached ? "attached" : "detached";

    public static byte[] Hello(string version, DeviceState state) => Build(w =>
    {
        w.WriteString("type", "hello");
        w.WriteNumber("protocol", Version);
        w.WriteString("version", version);
        w.WriteString("device", StateName(state));
    });

    public static byte[] Device(DeviceState state) => Build(w =>
    {
        w.WriteString("type", "device");
        w.WriteString("state", StateName(state));
    });

    public static byte[] Input(PendantInputReport report) => Build(w =>
    {
        w.WriteString("type", "input");
        w.WriteNumber("reportId", report.ReportId);
        WriteByteArray(w, "data", report.Data);
        w.WriteNumber("t", report.Timestamp);
    });

    public static byte[] DisplayAck(uint id) => Build(w =>
    {
        w.WriteString("type", "display:ack");
        w.WriteNumber("id", id);
    });

    public static byte[] DisplayError(uint id, string message) => Build(w =>
    {
        w.WriteString("type", "display:error");
        w.WriteNumber("id", id);
        w.WriteString("message", message);
    });

    public static byte[] Superseded() => Build(w => w.WriteString("type", "superseded"));

    public static void WriteByteArray(Utf8JsonWriter writer, string name, ReadOnlySpan<byte> bytes)
    {
        writer.WriteStartArray(name);
        foreach (var b in bytes)
        {
            writer.WriteNumberValue(b);
        }

        writer.WriteEndArray();
    }

    /// <summary>WebSocket close reasons are limited to 123 UTF-8 bytes; longer ones are cut on a character boundary.</summary>
    public static string CloseReason(string reason)
    {
        if (Encoding.UTF8.GetByteCount(reason) <= MaxCloseReasonBytes)
        {
            return reason;
        }

        var end = Math.Min(reason.Length, MaxCloseReasonBytes);
        while (Encoding.UTF8.GetByteCount(reason.AsSpan(0, end)) > MaxCloseReasonBytes)
        {
            end--;
        }

        return reason[..end];
    }

    /// <summary>Parses the only client message type (<c>display</c>). On failure <paramref name="error"/> is the 4400 close reason.</summary>
    public static bool TryParseClientMessage(ReadOnlySpan<byte> utf8, out DisplayRequest request, out string error)
    {
        request = default;
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(utf8.ToArray());
        }
        catch (Exception ex) when (ex is JsonException or ArgumentException)
        {
            error = "invalid JSON";
            return false;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                error = "message must be a JSON object";
                return false;
            }

            if (!root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String)
            {
                error = "missing \"type\"";
                return false;
            }

            if (type.GetString() != "display")
            {
                error = $"unknown message type \"{Truncate(type.GetString(), 32)}\"";
                return false;
            }

            if (!root.TryGetProperty("id", out var idElement)
                || idElement.ValueKind != JsonValueKind.Number
                || !idElement.TryGetUInt32(out var id))
            {
                error = "display: \"id\" must be an unsigned 32-bit integer";
                return false;
            }

            if (!TryReadBytes(root, "frame", PendantDevice.FrameLength, out var frame))
            {
                error = $"display: \"frame\" must be {PendantDevice.FrameLength} integers 0-255";
                return false;
            }

            request = new DisplayRequest(id, frame);
            error = "";
            return true;
        }
    }

    /// <summary>Reads <paramref name="name"/> as an array of exactly <paramref name="length"/> integers 0-255.</summary>
    public static bool TryReadBytes(JsonElement parent, string name, int length, out byte[] bytes)
    {
        bytes = [];
        if (!parent.TryGetProperty(name, out var array)
            || array.ValueKind != JsonValueKind.Array
            || array.GetArrayLength() != length)
        {
            return false;
        }

        var result = new byte[length];
        var index = 0;
        foreach (var item in array.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Number || !item.TryGetByte(out var value))
            {
                return false;
            }

            result[index++] = value;
        }

        bytes = result;
        return true;
    }

    private static byte[] Build(Action<Utf8JsonWriter> body)
    {
        var buffer = new ArrayBufferWriter<byte>(96);
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            body(writer);
            writer.WriteEndObject();
        }

        return buffer.WrittenSpan.ToArray();
    }

    private static string Truncate(string? value, int max) =>
        value is null || value.Length <= max ? value ?? "" : value[..max];
}
