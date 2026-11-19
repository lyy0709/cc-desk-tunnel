param(
  [string]$Bash,
  [Parameter(Mandatory)][int]$OwnerProcessId
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ComponentHost {
  const uint JobKillOnClose = 0x2000;
  const uint CreateSuspended = 0x4;
  const uint CreateNoWindow = 0x08000000;
  const uint Synchronize = 0x100000;
  const uint Infinite = uint.MaxValue;
  const int StartUseStdHandles = 0x100;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct StartupInfo {
    public int cb;
    public string reserved, desktop, title;
    public int x,y,xsize,ysize,xcount,ycount,fill,flags;
    public short show,reservedSize;
    public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit {
    public long processTime,jobTime;
    public uint flags;
    public UIntPtr minimumWorkingSet,maximumWorkingSet;
    public uint activeProcesses;
    public UIntPtr affinity;
    public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit {
    public BasicLimit basic;
    public IoCounters io;
    public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, int size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
    bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  public static int Run(string executable, string arguments, int ownerPid) {
    var job = CreateJobObject(IntPtr.Zero,null);
    if(job == IntPtr.Zero) throw new Win32Exception();
    IntPtr owner = IntPtr.Zero, child = IntPtr.Zero;
    try {
      var limits = new ExtendedLimit { basic = new BasicLimit { flags = JobKillOnClose } };
      var size = Marshal.SizeOf<ExtendedLimit>();
      var memory = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits,memory,false);
        if(!SetInformationJobObject(job,9,memory,size)) throw new Win32Exception();
      } finally { Marshal.FreeHGlobal(memory); }
      owner = OpenProcess(Synchronize,false,ownerPid);
      if(owner == IntPtr.Zero) throw new Win32Exception();
      var startup = new StartupInfo {
        cb=Marshal.SizeOf<StartupInfo>(), flags=StartUseStdHandles,
        input=GetStdHandle(-10),output=GetStdHandle(-11),error=GetStdHandle(-12)
      };
      ProcessInfo info;
      var command = new StringBuilder("\""+executable+"\" "+arguments);
      // Assign while suspended so no component child can escape the owner's job.
      if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,CreateNoWindow | CreateSuspended,
        IntPtr.Zero,null,ref startup,out info)) {
        var refused = new Win32Exception();
        // Read by the client to tell the user which component the system would not start, and why.
        Console.Error.WriteLine("cc-desk-tunnel: cannot start "+System.IO.Path.GetFileName(executable)+" error "+refused.NativeErrorCode);
        throw refused;
      }
      child = info.process;
      try {
        if(!AssignProcessToJobObject(job,info.process)) {
          var error = new Win32Exception();
          TerminateProcess(info.process,1);
          throw error;
        }
        if(ResumeThread(info.thread) == uint.MaxValue) throw new Win32Exception();
      } finally { CloseHandle(info.thread); }
      var completed = WaitForMultipleObjects(2, new IntPtr[] { child, owner }, false, Infinite);
      if(completed == 1) return 0;
      if(completed != 0) throw new Win32Exception();
      uint code;
      if(!GetExitCodeProcess(child,out code)) throw new Win32Exception();
      return (int)code;
    } finally {
      CloseHandle(job);
      if(owner != IntPtr.Zero) CloseHandle(owner);
      if(child != IntPtr.Zero) {
        WaitForSingleObject(child,5000);
        CloseHandle(child);
      }
    }
  }
}
'@
if ($Bash) {
  exit [ComponentHost]::Run($Bash, '-s', $OwnerProcessId)
}
$program = '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Console]::InputEncoding; $s=[Console]::In.ReadToEnd(); $global:LASTEXITCODE=$null; & ([scriptblock]::Create($s)); $ok=$?; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; exit [int](-not $ok)'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($program))
exit [ComponentHost]::Run([Environment]::ProcessPath, "-NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded", $OwnerProcessId)
