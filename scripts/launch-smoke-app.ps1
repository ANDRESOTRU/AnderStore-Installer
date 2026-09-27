param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'

# Isolated CI process launcher: the runner is administrative, but the application
# is tested with a normal user token and medium integrity. No OS policy is changed.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SmokeLauncher {
  [DllImport("user32.dll")]
  static extern IntPtr GetShellWindow();
  public static bool ShellAvailable() { return GetShellWindow()!=IntPtr.Zero; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct StartupInfo {
    public int cb; public string reserved, desktop, title;
    public int x,y,width,height,xChars,yChars,fill,flags;
    public short show, reservedSize; public IntPtr reservedData,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct SidAttributes { public IntPtr sid; public uint attributes; }
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool SaferCreateLevel(uint scope,uint level,uint flags,out IntPtr handle,IntPtr reserved);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool SaferComputeTokenFromLevel(IntPtr level,IntPtr input,out IntPtr token,uint flags,IntPtr reserved);
  [DllImport("advapi32.dll")]
  static extern bool SaferCloseLevel(IntPtr level);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertStringSidToSid(string value,out IntPtr sid);
  [DllImport("advapi32.dll")]
  static extern uint GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool SetTokenInformation(IntPtr token,int kind,ref SidAttributes info,uint size);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessAsUser(IntPtr token,string application,string command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInfo process);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr handle);
  static void Check(bool value,string operation) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
  public static uint Launch(string executable) {
    IntPtr level=IntPtr.Zero,token=IntPtr.Zero,sid=IntPtr.Zero;
    try {
      Check(SaferCreateLevel(1,0x20000,1,out level,IntPtr.Zero),"Create normal-user level");
      Check(SaferComputeTokenFromLevel(level,IntPtr.Zero,out token,0,IntPtr.Zero),"Create normal-user token");
      Check(ConvertStringSidToSid("S-1-16-8192",out sid),"Create medium-integrity SID");
      var label=new SidAttributes { sid=sid,attributes=0x20 };
      Check(SetTokenInformation(token,25,ref label,(uint)Marshal.SizeOf(typeof(SidAttributes))+GetLengthSid(sid)),"Set child token integrity");
      var startup=new StartupInfo { cb=Marshal.SizeOf(typeof(StartupInfo)),desktop="winsta0\\default" };
      ProcessInfo process;
      Check(CreateProcessAsUser(token,executable,"\""+executable+"\"",IntPtr.Zero,IntPtr.Zero,false,0,IntPtr.Zero,null,ref startup,out process),"Launch installed app");
      CloseHandle(process.process); CloseHandle(process.thread);
      return process.processId;
    } finally {
      if(sid!=IntPtr.Zero)LocalFree(sid);
      if(token!=IntPtr.Zero)CloseHandle(token);
      if(level!=IntPtr.Zero)SaferCloseLevel(level);
    }
  }
}
'@
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
Write-Output "Desktop shell available: $([SmokeLauncher]::ShellAvailable())"
Write-Output "Baseline test process: $([SmokeLauncher]::Launch($resolvedExecutable))"
