using System.Net;
using System.Net.Sockets;

namespace Whb04bSidecar.Server;

/// <summary>How a request's origin is treated.</summary>
internal enum OriginVerdict
{
    Allowed,

    /// <summary>Not allowed, but looks like a CNCjs host on the local network: WebSocket upgrades get a 4403 explanation.</summary>
    DeniedLocalNetwork,

    /// <summary>Not allowed (public sites, odd schemes): plain 403, indistinguishable from no sidecar.</summary>
    Denied,
}

/// <summary>
/// Which browser origins may talk to the sidecar: no Origin (local tools), http(s) on localhost / 127.0.0.1 / [::1]
/// with any port, plus explicitly configured extras.
/// </summary>
internal sealed class OriginPolicy
{
    private static readonly HashSet<string> LoopbackHosts = new(StringComparer.OrdinalIgnoreCase) { "localhost", "127.0.0.1", "[::1]" };
    private static readonly string[] LocalNameSuffixes = [".local", ".lan", ".home.arpa", ".internal"];

    private readonly HashSet<string> _extra;

    public OriginPolicy(IEnumerable<string> extraOrigins)
    {
        _extra = new HashSet<string>(StringComparer.Ordinal);
        foreach (var origin in extraOrigins)
        {
            if (TryNormalize(origin, out var normalized))
            {
                _extra.Add(normalized);
            }
        }
    }

    public IReadOnlyCollection<string> ExtraOrigins => _extra;

    /// <summary><paramref name="origin"/> is the raw header value; null/empty means the header was absent.</summary>
    public bool IsAllowed(string? origin)
    {
        if (string.IsNullOrEmpty(origin))
        {
            return true;
        }

        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || !IsHttp(uri))
        {
            return false;
        }

        if (LoopbackHosts.Contains(uri.Host))
        {
            return true;
        }

        return TryNormalize(origin, out var normalized) && _extra.Contains(normalized);
    }

    public OriginVerdict Classify(string? origin)
    {
        if (IsAllowed(origin))
        {
            return OriginVerdict.Allowed;
        }

        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || !IsHttp(uri))
        {
            return OriginVerdict.Denied;
        }

        return IsLocalNetworkHost(uri) ? OriginVerdict.DeniedLocalNetwork : OriginVerdict.Denied;
    }

    /// <summary>
    /// Private/link-local/CGNAT IPv4 literals, ULA/link-local IPv6 literals, single-label names (e.g. raspberrypi)
    /// and names under .local, .lan, .home.arpa or .internal.
    /// </summary>
    public static bool IsLocalNetworkHost(Uri uri)
    {
        switch (uri.HostNameType)
        {
            case UriHostNameType.IPv4:
                return IsLocalNetworkAddress(IPAddress.Parse(uri.Host));
            case UriHostNameType.IPv6:
                return IsLocalNetworkAddress(IPAddress.Parse(uri.DnsSafeHost));
            case UriHostNameType.Dns:
                var host = uri.IdnHost.TrimEnd('.');
                return !host.Contains('.') || LocalNameSuffixes.Any(suffix => host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase));
            default:
                return false;
        }
    }

    private static bool IsLocalNetworkAddress(IPAddress address)
    {
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            return address.IsIPv6UniqueLocal || address.IsIPv6LinkLocal;
        }

        var b = address.GetAddressBytes();
        return b[0] == 10
            || (b[0] == 172 && b[1] is >= 16 and <= 31)
            || (b[0] == 192 && b[1] == 168)
            || (b[0] == 169 && b[1] == 254)
            || (b[0] == 100 && b[1] is >= 64 and <= 127);
    }

    /// <summary>Canonical <c>scheme://host[:port]</c> (lower-case, default port omitted, no path). False if not an http(s) origin.</summary>
    public static bool TryNormalize(string origin, out string normalized)
    {
        normalized = "";
        if (!Uri.TryCreate(origin.Trim(), UriKind.Absolute, out var uri) || !IsHttp(uri))
        {
            return false;
        }

        if (uri.AbsolutePath != "/" || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.UserInfo.Length > 0)
        {
            return false;
        }

        normalized = uri.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped).ToLowerInvariant();
        return true;
    }

    private static bool IsHttp(Uri uri) => uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps;
}
