namespace WHB04B6Controller;

public class TestClass
{
    // Private method first (should cause error)
    private void PrivateMethod()
    {
    }

    // Public method after private (should cause error)
    public void PublicMethod()
    {
    }

    // Protected method (should cause error since it comes after public)
    protected void ProtectedMethod()
    {
    }

    // Internal method (should cause error since it comes after protected)
    internal void InternalMethod()
    {
    }
}