using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace AgentX.PhotoImport.Test {
  // A device stream that enforces its advertised transfer size. No WPD/COM
  // device is opened by the transfer regression tests.
  public class SizedStream : IStream {
    private byte[] bytes;
    private int position;
    private int maximum;
    public int Calls;
    public bool InvalidCount;
    public SizedStream(byte[] value,int max) { bytes=value; maximum=max; }
    public void Read(byte[] target,int count,IntPtr read) {
      Calls++;
      if(count>maximum) throw new ArgumentOutOfRangeException("count");
      int n=Math.Min(Math.Min(count,1231),bytes.Length-position);
      Array.Copy(bytes,position,target,0,n);position+=n;
      Marshal.WriteInt32(read,InvalidCount ? count+1 : n);
    }
    public void Write(byte[] p,int n,IntPtr count) { throw new NotSupportedException(); }
    public void Seek(long offset,int origin,IntPtr position) { throw new NotSupportedException(); }
    public void SetSize(long size) { throw new NotSupportedException(); }
    public void CopyTo(IStream other,long count,IntPtr read,IntPtr written) { throw new NotSupportedException(); }
    public void Commit(int flags) { throw new NotSupportedException(); }
    public void Revert() { throw new NotSupportedException(); }
    public void LockRegion(long offset,long count,int type) { throw new NotSupportedException(); }
    public void UnlockRegion(long offset,long count,int type) { throw new NotSupportedException(); }
    public void Stat(out System.Runtime.InteropServices.ComTypes.STATSTG stat,int flags) { throw new NotSupportedException(); }
    public void Clone(out IStream stream) { throw new NotSupportedException(); }
  }
}
