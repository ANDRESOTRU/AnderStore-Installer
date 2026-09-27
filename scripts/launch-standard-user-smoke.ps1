param([Parameter(Mandatory=$true)][string]$Executable, [string]$Arguments = '', [switch]$Wait)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class StandardUserSmoke {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
  struct StartupInfo {
    public int cb; public string reserved,desktop,title;
    public int x,y,width,height,xChars,yChars,fill,flags;
    public short show,reservedSize; public IntPtr reservedData,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process,thread; public uint processId,threadId; }
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern bool CreateProcessWithLogonW(string user,string domain,string password,uint logonFlags,string application,string command,uint flags,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInfo process);
  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  public static uint Launch(string executable,string arguments,bool wait) {
    var values=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
    foreach(DictionaryEntry item in Environment.GetEnvironmentVariables())values[(string)item.Key]=(string)item.Value;
    var profile=Environment.GetEnvironmentVariable("ANDERSTORE_SMOKE_PROFILE");
    var username=Environment.GetEnvironmentVariable("ANDERSTORE_SMOKE_USERNAME");
    var password=Environment.GetEnvironmentVariable("ANDERSTORE_SMOKE_PASSWORD");
    values["USERNAME"]=username; values["USERPROFILE"]=profile;
    values["APPDATA"]=profile+"\\AppData\\Roaming"; values["LOCALAPPDATA"]=profile+"\\AppData\\Local";
    // No credentials or runner tokens belong in the application environment.
    values.Remove("ANDERSTORE_SMOKE_PASSWORD"); values.Remove("ANDERSTORE_SMOKE_USERNAME");
    values.Remove("GITHUB_TOKEN"); values.Remove("GH_TOKEN");
    var block="";
    foreach(var item in values)block+=item.Key+"="+item.Value+"\0";
    var environment=Marshal.StringToHGlobalUni(block+"\0");
    var startup=new StartupInfo { cb=Marshal.SizeOf(typeof(StartupInfo)),desktop="winsta0\\default",flags=wait?1:0,show=0 };
    ProcessInfo process;
    try {
      if(!CreateProcessWithLogonW(username,".",password,1,executable,"\""+executable+"\" "+arguments,0x400,environment,null,ref startup,out process))
        throw new Win32Exception(Marshal.GetLastWin32Error(),"Launch ordinary Windows test user");
      try {
        if(!wait)return process.processId;
        if(WaitForSingleObject(process.process,180000)!=0)throw new Exception("Child process timed out");
        uint code;
        if(!GetExitCodeProcess(process.process,out code))throw new Win32Exception(Marshal.GetLastWin32Error());
        return code;
      } finally { CloseHandle(process.process); CloseHandle(process.thread); }
    } finally { Marshal.FreeHGlobal(environment); }
  }
}
'@
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$result = [StandardUserSmoke]::Launch($resolvedExecutable, $Arguments, $Wait.IsPresent)
Write-Output "Standard user process result: $result"
if ($Wait -and $result -ne 0) { throw "Child process failed: $result" }
