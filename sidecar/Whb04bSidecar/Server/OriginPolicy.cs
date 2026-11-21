namespace Whb04bSidecar.Server;

/// <summary>
/// Which browser origins may talk to the sidecar: no Origin (local tools), http(s) on localhost / 127.0.0.1 / [::1]
/// with any port, plus explicitly configured extras.
/// </summary>
internal sealed class OriginPolicy
{
    private static readonly HashSet<string> LoopbackHosts = new(StringComparer.OrdinalIgnoreCase) { "localhost", "127.0.0.1", "[::1]" };

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
