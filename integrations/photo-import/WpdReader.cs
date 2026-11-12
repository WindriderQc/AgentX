// Native Windows transport. Interface slots/keys follow Microsoft's WPD SDK
// (PortableDeviceApi.h / PortableDeviceTypes.h / PortableDevice.h). Deliberately
// the default reader opens read-only. Explicit cleanup is in WpdCleanup.cs.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;

namespace AgentX.PhotoImport {
  [StructLayout(LayoutKind.Sequential, Pack=4)] public struct Key {
    public Guid fmtid; public uint pid;
    public Key(string guid, uint id) { fmtid=new Guid(guid); pid=id; }
  }
  [StructLayout(LayoutKind.Explicit, Size=24)] public struct Variant {
    [FieldOffset(0)] public ushort type;
    [FieldOffset(8)] public long number;
    [FieldOffset(8)] public IntPtr pointer;
  }
  [ComImport, Guid("a1567595-4c2f-4574-a6fa-ecef917b9a40"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Manager {
    void GetDevices(IntPtr ids, ref uint count);
    void RefreshDeviceList();
    void GetDeviceFriendlyName([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr name, ref uint count);
  }
  [ComImport, Guid("625e2df8-6392-4cf0-9ad1-3cfa5f17775c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Device {
    void Open([MarshalAs(UnmanagedType.LPWStr)] string id, Values info);
    void UnusedSendCommand();
    void Content(out Content content);
    void UnusedCapabilities();
    void Cancel();
    void Close();
  }
  [ComImport, Guid("6a96ed84-7c73-4480-9938-bf5af477d426"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Content {
    void EnumObjects(uint flags, [MarshalAs(UnmanagedType.LPWStr)] string parent, IntPtr filter, out ObjectIds ids);
    void Properties(out Properties properties);
    void Transfer(out Resources resources);
    void UnusedCreateObjectWithPropertiesOnly();
    void UnusedCreateObjectWithPropertiesAndData();
    [PreserveSig] int Delete(uint options, VariantCollection ids, [In, Out] ref VariantCollection results);
  }
  [ComImport, Guid("10ece955-cf41-4728-bfa0-41eedf1bbf19"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ObjectIds {
    [PreserveSig] int Next(uint count, out IntPtr id, ref uint fetched);
  }
  [ComImport, Guid("7f6d695c-03df-4439-a809-59266beee3a6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Properties {
    void UnusedGetSupportedProperties();
    void UnusedGetPropertyAttributes();
    void GetValues([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr keys, out Values values);
  }
  [ComImport, Guid("fd8878ac-d841-4d17-891c-e6829cdb6934"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Resources {
    void UnusedGetSupportedResources();
    void UnusedGetResourceAttributes();
    void GetStream([MarshalAs(UnmanagedType.LPWStr)] string id, ref Key key, uint mode, ref uint optimal, out IStream stream);
  }
  [ComImport, Guid("6848f6f2-3155-4f86-b6f5-263eeeab3143"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Values {
    void UnusedGetCount(); void UnusedGetAt(); void UnusedSetValue();
    [PreserveSig] int GetValue(ref Key key, out Variant value);
    void UnusedSetStringValue();
    [PreserveSig] int GetStringValue(ref Key key, [MarshalAs(UnmanagedType.LPWStr)] out string value);
    void SetUnsignedIntegerValue(ref Key key, uint value);
    void UnusedGetUnsignedIntegerValue(); void UnusedSetSignedIntegerValue(); void UnusedGetSignedIntegerValue();
    void UnusedSetUnsignedLargeIntegerValue();
    [PreserveSig] int GetUnsignedLargeIntegerValue(ref Key key, out ulong value);
  }
  [ComImport, Guid("89b2e422-4f1b-4316-bcef-a44afea83eb3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface VariantCollection {
    void GetCount(out uint count);
    void GetAt(uint index, out Variant value);
    void Add(ref Variant value);
  }
  public class Source {
    public string objectId, key, name, relativePath, modified;
    public ulong size;
  }
  public class Inventory {
    public List<Source> files=new List<Source>();
    public List<string> errors=new List<string>();
    public int objectsVisited;
    public bool complete=true;
  }
  public sealed partial class Reader : IDisposable {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref Variant value);
    static readonly string ObjectKeys="EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C";
    static readonly Guid Folder=new Guid("27E2E392-A111-48E0-AB0C-E17705A05F85");
    static readonly Guid Functional=new Guid("99ED0160-17FF-4C44-9D98-1D7A6F941921");
    Device device; Content content; Properties properties; internal bool CleanupWritable { get; private set; }
    static object Create(string guid) { return Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(guid))); }
    static void Release(object value) { if(value!=null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    static string StringValue(Values values, uint pid) {
      var key=new Key(ObjectKeys,pid); string value;
      return values.GetStringValue(ref key,out value)>=0 ? value : null;
    }
    static string Modified(Values values) {
      var key=new Key(ObjectKeys,19); Variant value;
      if(values.GetValue(ref key,out value)<0) return null;
      try { return value.type==64 || value.type==7 ? value.type+":"+value.number : null; }
      finally { PropVariantClear(ref value); }
    }
    public static List<Dictionary<string,string>> Devices() {
      var result=new List<Dictionary<string,string>>();
      Manager manager=(Manager)Create("0AF10CEC-2ECD-4B92-9581-34F6AE0637F3");
      IntPtr buffer=IntPtr.Zero;
      try {
        manager.RefreshDeviceList(); uint count=0;manager.GetDevices(IntPtr.Zero,ref count);
        if(count>1024) throw new IOException("Unexpected WPD device count");
        buffer=Marshal.AllocCoTaskMem((int)count*IntPtr.Size);
        uint capacity=count;manager.GetDevices(buffer,ref count);
        if(count>capacity) throw new IOException("WPD device list changed; retry discovery");
        for(int i=0;i<count;i++) {
          IntPtr ptr=Marshal.ReadIntPtr(buffer,i*IntPtr.Size);string id=Marshal.PtrToStringUni(ptr);Marshal.FreeCoTaskMem(ptr);
          uint chars=0;manager.GetDeviceFriendlyName(id,IntPtr.Zero,ref chars);
          if(chars>32768) throw new IOException("Invalid WPD device name");
          IntPtr name=Marshal.AllocCoTaskMem((int)Math.Max(chars,1)*2);
          try { manager.GetDeviceFriendlyName(id,name,ref chars);result.Add(new Dictionary<string,string>{{"id",id},{"name",Marshal.PtrToStringUni(name)}}); }
          finally { Marshal.FreeCoTaskMem(name); }
        }
        return result;
      } finally { if(buffer!=IntPtr.Zero) Marshal.FreeCoTaskMem(buffer);Release(manager); }
    }
    public Reader(string id) : this(id,false) {}
    internal Reader(string id,bool writable) {
      CleanupWritable=writable;
      Values info=(Values)Create("0C15D503-D017-47CE-9016-7B3F978721CC");
      try {
        // WPD otherwise defaults to GENERIC_READ | GENERIC_WRITE.
        var access=new Key("204D9F0C-2292-4080-9F42-40664E70F859",9);
        info.SetUnsignedIntegerValue(ref access,writable?0xc0000000:0x80000000); // normal reader: GENERIC_READ
        device=(Device)Create("F7C0039A-4762-488A-B4B3-760EF9A1BA9B");
        device.Open(id,info);device.Content(out content);content.Properties(out properties);
      } catch { Dispose();throw; } finally { Release(info); }
    }
    Source Snapshot(string id, string relative) {
      Values values;properties.GetValues(id,IntPtr.Zero,out values);
      try {
        var sizeKey=new Key(ObjectKeys,11);ulong size;
        if(values.GetUnsignedLargeIntegerValue(ref sizeKey,out size)<0) throw new IOException("Missing object size: "+relative);
        var name=StringValue(values,12) ?? StringValue(values,4);
        if(String.IsNullOrEmpty(name)) throw new IOException("Missing object name");
        return new Source {objectId=id,key=StringValue(values,5) ?? relative,name=name,relativePath=relative,size=size,modified=Modified(values)};
      } finally { Release(values); }
    }
    public Inventory Enumerate(int maxObjects) {
      var result=new Inventory();var seen=new HashSet<string>();
      Walk("DEVICE","",result,seen,maxObjects,0);return result;
    }
    void Walk(string parent,string prefix,Inventory result,HashSet<string> seen,int limit,int depth) {
      if(depth>64) { result.errors.Add("Folder depth limit: "+prefix);result.complete=false;return; }
      ObjectIds ids=null;
      try {
        content.EnumObjects(0,parent,IntPtr.Zero,out ids);
        while(true) {
          IntPtr ptr;uint fetched=0;int hr=ids.Next(1,out ptr,ref fetched);
          if(hr<0) Marshal.ThrowExceptionForHR(hr);
          if(fetched==0) break;
          string id=Marshal.PtrToStringUni(ptr);Marshal.FreeCoTaskMem(ptr);
          if(!seen.Add(id)) continue;
          if(++result.objectsVisited>limit) { result.complete=false;result.errors.Add("Object enumeration bound reached");return; }
          Values values=null;
          try {
            properties.GetValues(id,IntPtr.Zero,out values);
            var name=StringValue(values,12) ?? StringValue(values,4);
            if(String.IsNullOrEmpty(name)) throw new IOException("Missing name");
            string relative=prefix.Length==0?name:prefix+"/"+name;
            var key=new Key(ObjectKeys,7);Variant value;
            if(values.GetValue(ref key,out value)<0) throw new IOException("Missing content type");
            Guid type=Guid.Empty;
            try { if(value.type==72 && value.pointer!=IntPtr.Zero) type=(Guid)Marshal.PtrToStructure(value.pointer,typeof(Guid)); }
            finally { PropVariantClear(ref value); }
            if(type==Folder || type==Functional) Walk(id,relative,result,seen,limit,depth+1);
            else result.files.Add(Snapshot(id,relative));
          } catch(Exception e) { result.complete=false;result.errors.Add(prefix+": "+e.Message); }
          finally { Release(values); }
          if(result.objectsVisited>limit) return;
        }
      } catch(Exception e) { result.complete=false;result.errors.Add(prefix+": "+e.Message); }
      finally { Release(ids); }
    }
    public Dictionary<string,object> Read(string id,string relative,string destination) {
      var before=Snapshot(id,relative);IStream stream=null;Resources resources=null;
      IntPtr bytesRead=Marshal.AllocCoTaskMem(4);
      try {
        content.Transfer(out resources);uint optimal=0;
        var key=new Key("E81E79BE-34F0-41BF-B53F-F1A06AE87842",0);
        resources.GetStream(id,ref key,0,ref optimal,out stream); // STGM_READ only
        byte[] buffer=new byte[1024*1024];ulong total=0;string sha;
        using(var output=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None))
        using(var hash=SHA256.Create()) {
          while(true) {
            Marshal.WriteInt32(bytesRead,0);stream.Read(buffer,buffer.Length,bytesRead);
            int read=Marshal.ReadInt32(bytesRead);if(read==0) break;
            if(read<0 || read>buffer.Length) throw new IOException("Invalid WPD read count");
            total+=(ulong)read;if(total>before.size) throw new IOException("Object grew during transfer");
            output.Write(buffer,0,read);hash.TransformBlock(buffer,0,read,null,0);
          }
          hash.TransformFinalBlock(new byte[0],0,0);sha=BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant();output.Flush(true);
        }
        var after=Snapshot(id,relative);
        if(total!=before.size || before.key!=after.key || before.name!=after.name || before.size!=after.size || before.modified!=after.modified) throw new IOException("Source changed or transfer was incomplete");
        return new Dictionary<string,object>{{"sha256",sha},{"size",total},{"source",before},{"phoneReadOnly",true},{"sourceChecksumIndependent",false}};
      } finally { Marshal.FreeCoTaskMem(bytesRead);Release(stream);Release(resources); }
    }
    public string ReadPrefix(string id) {
      Resources resources=null;IStream stream=null;IntPtr count=Marshal.AllocCoTaskMem(4);
      try {
        content.Transfer(out resources);uint optimal=0;
        var key=new Key("E81E79BE-34F0-41BF-B53F-F1A06AE87842",0);
        resources.GetStream(id,ref key,0,ref optimal,out stream);
        // Drain the resource: some MTP drivers keep the device busy when an
        // object stream is abandoned after a short read. Retain only 64 bytes.
        byte[] bytes=new byte[1024*1024];int total=0;
        using(var output=new MemoryStream()) {
          while(true) {
            Marshal.WriteInt32(count,0);stream.Read(bytes,bytes.Length,count);
            int n=Marshal.ReadInt32(count);if(n==0)break;
            if(n<0 || n>bytes.Length)throw new IOException("Invalid WPD prefix size");
            int keep=Math.Min(n,64-total);if(keep>0)output.Write(bytes,0,keep);total+=keep;
          }
          return Convert.ToBase64String(output.ToArray());
        }
      } finally {Marshal.FreeCoTaskMem(count);Release(stream);Release(resources);}
    }
    public void Dispose() {
      Release(properties);properties=null;Release(content);content=null;
      if(device!=null) { try {device.Close();}finally{Release(device);device=null;} }
    }
  }
}
