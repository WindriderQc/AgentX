// Only cleanup.ps1 loads this module. Normal import has no writable entrance.
// SDK: IPortableDeviceContent::Delete, NO_RECURSION, exact per-object results.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace AgentX.PhotoImport {
  public sealed partial class Reader {
    Source removalSource;
    public static Reader OpenForCleanup(string id) { return new Reader(id,true); }
    public Dictionary<string,object> PrepareRemoval(string objectId,string relative,string destination,
      string key,string name,ulong size,string modified,string sha256) {
      if(!CleanupWritable || size==0 || String.IsNullOrEmpty(key)) throw new IOException("Cleanup is not enabled");
      Values values=null;
      try {
        properties.GetValues(objectId,IntPtr.Zero,out values);
        var typeKey=new Key(ObjectKeys,7);Variant value;
        if(values.GetValue(ref typeKey,out value)<0) throw new IOException("Unknown source type");
        try {
          if(value.type!=72 || value.pointer==IntPtr.Zero) throw new IOException("Unknown source type");
          Guid type=(Guid)Marshal.PtrToStructure(value.pointer,typeof(Guid));
          if(type==Folder || type==Functional) throw new IOException("Folders cannot be deleted");
        } finally {PropVariantClear(ref value);}
      } finally {Release(values);}
      CheckRemovalPath(objectId,relative);
      var result=Read(objectId,relative,destination);
      var source=(Source)result["source"];
      if(source.key!=key || source.name!=name || source.size!=size || source.modified!=modified ||
        (string)result["sha256"]!=sha256) throw new IOException("Source differs from selected verified backup");
      removalSource=source;
      return result;
    }
    void CheckRemovalPath(string objectId,string expected) {
      var names=new List<string>();var seen=new HashSet<string>();string current=objectId;
      while(current!="DEVICE") {
        if(String.IsNullOrEmpty(current) || !seen.Add(current) || seen.Count>64) throw new IOException("Unverifiable source path");
        Values values=null;
        try {
          properties.GetValues(current,IntPtr.Zero,out values);
          if(current==objectId) {
            var typeKey=new Key(ObjectKeys,7);Variant kind;
            if(values.GetValue(ref typeKey,out kind)<0) throw new IOException("Unknown source type");
            try {
              if(kind.type!=72 || kind.pointer==IntPtr.Zero) throw new IOException("Unknown source type");
              Guid type=(Guid)Marshal.PtrToStructure(kind.pointer,typeof(Guid));
              if(type==Folder || type==Functional) throw new IOException("Folders cannot be deleted");
            }finally{PropVariantClear(ref kind);}
          }
          string name=StringValue(values,12)??StringValue(values,4);
          if(String.IsNullOrEmpty(name))throw new IOException("Unverifiable source name");
          names.Add(name);current=StringValue(values,3);
        }finally{Release(values);}
      }
      names.Reverse();if(String.Join("/",names.ToArray())!=expected)throw new IOException("Source moved after backup");
    }
    public void ConfirmRemoval(string dispatchFile,string intent) {
      if(!CleanupWritable || removalSource==null) throw new IOException("Verified source required");
      CheckRemovalPath(removalSource.objectId,removalSource.relativePath);
      var fresh=Snapshot(removalSource.objectId,removalSource.relativePath);
      if(fresh.key!=removalSource.key || fresh.name!=removalSource.name || fresh.size!=removalSource.size ||
        fresh.modified!=removalSource.modified) throw new IOException("Source changed after preparation");
      // Write before WPD's effect. A crash after this fence is uncertain and
      // must never be repaired by automatically sending another Delete.
      byte[] bytes=Encoding.UTF8.GetBytes(intent);
      using(var file=new FileStream(dispatchFile,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
        file.Write(bytes,0,bytes.Length);file.Flush(true);
      }
      VariantCollection ids=null,results=null;
      var entry=new Variant {type=31,pointer=Marshal.StringToCoTaskMemUni(fresh.objectId)};
      try {
        ids=(VariantCollection)Create("08a99e2f-6d6d-4b80-af5a-baf2bcbe4cb9");ids.Add(ref entry);
        int hr=content.Delete(0,ids,ref results); // PORTABLE_DEVICE_DELETE_NO_RECURSION
        if(hr!=0 || results==null) throw new IOException("CLEANUP_UNCERTAIN: WPD result was not an exact success");
        uint count;results.GetCount(out count);
        if(count!=1) throw new IOException("CLEANUP_UNCERTAIN: missing per-object result");
        Variant result;results.GetAt(0,out result);
        try { if(result.type!=10 || unchecked((int)result.number)!=0) throw new IOException("CLEANUP_UNCERTAIN: per-object deletion failed"); }
        finally {PropVariantClear(ref result);}
        removalSource=null;
      } finally {PropVariantClear(ref entry);Release(ids);Release(results);}
    }
  }
}
