using System.Globalization;
using System.Text;
using Microsoft.Extensions.Logging;

namespace Whb04bSidecar.Logging;

/// <summary>
/// Minimal rolling file logger: one file per day (<c>sidecar-yyyyMMdd.log</c>), rolled to
/// <c>sidecar-yyyyMMdd.N.log</c> past <see cref="MaxFileBytes"/>, keeping the newest <see cref="RetainedFiles"/>.
/// Log volume is low (no per-report Information logs), so a lock and a flushed writer are enough.
/// </summary>
internal sealed class FileLoggerProvider : ILoggerProvider
{
    public const long MaxFileBytes = 5 * 1024 * 1024;
    public const int RetainedFiles = 14;
    private const string Prefix = "sidecar-";

    private readonly string _directory;
    private readonly object _lock = new();
    private StreamWriter? _writer;
    private string? _day;
    private int _index;
    private bool _failed;

    public FileLoggerProvider(string directory)
    {
        _directory = directory;
    }

    public ILogger CreateLogger(string categoryName) => new FileLogger(this, ShortCategory(categoryName));

    public void Dispose()
    {
        lock (_lock)
        {
            _writer?.Dispose();
            _writer = null;
        }
    }

    internal void Write(LogLevel level, string category, string message, Exception? exception)
    {
        var now = DateTimeOffset.Now;
        var line = new StringBuilder(128)
            .Append(now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz", CultureInfo.InvariantCulture))
            .Append(' ')
            .Append(LevelTag(level))
            .Append(' ')
            .Append(category)
            .Append(": ")
            .Append(message);
        if (exception is not null)
        {
            line.AppendLine().Append(exception);
        }

        lock (_lock)
        {
            if (_failed)
            {
                return;
            }

            try
            {
                var writer = EnsureWriter(now);
                writer.WriteLine(line);
                writer.Flush();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Logging must never take the relay down; give up on the file sink for this run.
                _failed = true;
                _writer?.Dispose();
                _writer = null;
            }
        }
    }

    private StreamWriter EnsureWriter(DateTimeOffset now)
    {
        var day = now.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
        if (_writer is not null && day == _day && _writer.BaseStream.Length < MaxFileBytes)
        {
            return _writer;
        }

        _writer?.Dispose();
        _writer = null;
        Directory.CreateDirectory(_directory);
        if (day != _day)
        {
            _day = day;
            _index = HighestIndex(day);
        }

        while (true)
        {
            var path = Path.Combine(_directory, FileName(day, _index));
            var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            if (stream.Length < MaxFileBytes)
            {
                _writer = new StreamWriter(stream, new UTF8Encoding(false));
                PruneOldFiles();
                return _writer;
            }

            stream.Dispose();
            _index++;
        }
    }

    private int HighestIndex(string day)
    {
        var highest = 0;
        foreach (var file in Directory.EnumerateFiles(_directory, $"{Prefix}{day}*.log"))
        {
            var parts = Path.GetFileNameWithoutExtension(file).Split('.');
            if (parts.Length == 2 && int.TryParse(parts[1], out var index) && index > highest)
            {
                highest = index;
            }
        }

        return highest;
    }

    private void PruneOldFiles()
    {
        var files = new DirectoryInfo(_directory)
            .GetFiles($"{Prefix}*.log")
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .Skip(RetainedFiles);
        foreach (var file in files)
        {
            try
            {
                file.Delete();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Open in an editor or similar; try again on the next roll.
            }
        }
    }

    private static string FileName(string day, int index) => index == 0 ? $"{Prefix}{day}.log" : $"{Prefix}{day}.{index}.log";

    private static string ShortCategory(string category)
    {
        var dot = category.LastIndexOf('.');
        return dot < 0 ? category : category[(dot + 1)..];
    }

    private static string LevelTag(LogLevel level) => level switch
    {
        LogLevel.Trace => "TRC",
        LogLevel.Debug => "DBG",
        LogLevel.Information => "INF",
        LogLevel.Warning => "WRN",
        LogLevel.Error => "ERR",
        LogLevel.Critical => "CRT",
        _ => "???",
    };

    private sealed class FileLogger(FileLoggerProvider provider, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }

            provider.Write(logLevel, category, formatter(state, exception), exception);
        }
    }
}
