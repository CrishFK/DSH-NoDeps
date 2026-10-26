; Inno Setup script for DSH NoDeps.
; Build with installer\build.ps1 (packages the Electron app into installer\payload, then runs ISCC).
;
; Design goals
;  - Everything lives in one folder ({app}, default C:\DSH NoDeps): the app, the portable Node.js and dsh
;    (runtime\), the npm cache and the embedded browser profile (data\). Nothing goes anywhere else.
;  - Per-user install: no administrator rights, no PATH or environment changes.
;  - Uninstall removes the whole folder, the Start menu / desktop shortcuts and the uninstall registry entry,
;    and optionally (asked, default No) the user's DeepSeek data (chats, settings, API key).
;  - English only.

#define AppName "DSH NoDeps"
#define AppExe "DshLauncher.exe"
; The release workflow passes the version from the git tag: ISCC /DAppVersion=1.2.3
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppPublisher "CrishFK"

[Setup]
AppId={{77D3646D-6A19-4E38-B1B2-8E0582DCF4C8}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName=C:\DSH NoDeps
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Output
OutputBaseFilename=DSH-NoDeps-Setup
SetupIconFile=..\app.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
; First wizard page: the unofficial-launcher disclaimer (see DISCLAIMER.md).
InfoBeforeFile=..\DISCLAIMER.md
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Lets a silent update close the running app if it still holds files; the app starts again via /relaunch=1 (see [Run]).
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[InstallDelete]
; The WebView2 builds (1.0.x) kept their browser profile here; the Electron builds cannot use it.
Type: filesandordirs; Name: "{app}\data\WebView2"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
; The app updates itself by running this installer silently with /relaunch=1; it then expects to be started again.
Filename: "{app}\{#AppExe}"; Flags: nowait; Check: RelaunchRequested

[UninstallDelete]
; The folder is guaranteed to be ours (see NextButtonClick / InitializeUninstall), so remove all of it:
; runtime\ (Node.js, dsh, npm cache) and data\ (browser profile, window placement).
Type: filesandordirs; Name: "{app}"

[Code]
{ The app falls back to %LOCALAPPDATA%\DshLauncher when its own folder is not writable. }
var
  DeleteFallbackData: Boolean;

function IsRootPath(const Path: String): Boolean;
begin
  Result := Length(RemoveBackslashUnlessRoot(Path)) <= 3;
end;

function DirHasEntries(const Dir: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result := False;
  if FindFirst(AddBackslash(Dir) + '*', FindRec) then
  try
    repeat
      if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
      begin
        Result := True;
        Exit;
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

{ Refuse roots and folders that hold other people's files: uninstall deletes the whole folder. }
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Dir: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    Dir := RemoveBackslashUnlessRoot(WizardDirValue);
    if IsRootPath(Dir) then
    begin
      MsgBox('Please choose a folder, not the root of a drive. Everything is stored in this folder ' +
             'and removed when you uninstall.', mbError, MB_OK);
      Result := False;
    end
    else if DirExists(Dir) and DirHasEntries(Dir) and
            not FileExists(AddBackslash(Dir) + '{#AppExe}') then
    begin
      MsgBox('The folder "' + Dir + '" already contains other files.' + #13#10 + #13#10 +
             'Everything inside the installation folder is deleted when you uninstall, so please ' +
             'choose an empty or new folder (for example "' + Dir + '\DSH NoDeps").', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

{ An interrupted earlier install can leave an empty uninstall log, which makes the uninstaller refuse to run
  ("unins000.dat is corrupted"). Drop it so this install writes a fresh one. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Dat: String;
  Size: Integer;
begin
  Result := '';
  Dat := ExpandConstant('{app}\unins000.dat');
  if FileExists(Dat) and FileSize(Dat, Size) and (Size = 0) then
  begin
    DeleteFile(Dat);
    DeleteFile(ExpandConstant('{app}\unins000.exe'));
  end;
end;

{ True when the app started this installer to update itself (/relaunch=1). Plain silent installs do not start the app. }
function RelaunchRequested(): Boolean;
begin
  Result := ExpandConstant('{param:relaunch|0}') = '1';
end;

{ Only ever delete a folder that really is our installation. }
function InitializeUninstall(): Boolean;
begin
  Result := True;
  if (not FileExists(ExpandConstant('{app}\{#AppExe}'))) or IsRootPath(ExpandConstant('{app}')) then
  begin
    MsgBox('This folder does not look like a DSH NoDeps installation, so nothing will be deleted.',
           mbError, MB_OK);
    Result := False;
  end;
end;

function DshHomeDir(): String;
begin
  Result := GetEnv('DSH_HOME');
  if Result = '' then
    Result := ExpandConstant('{%USERPROFILE}') + '\.dsh';
  Result := RemoveBackslashUnlessRoot(Result);
end;

{ dsh keeps its data outside the install folder; only touch it if it clearly is a Harness home. }
function LooksLikeDshHome(const Dir: String): Boolean;
begin
  Result := (not IsRootPath(Dir)) and DirExists(Dir) and
            (FileExists(AddBackslash(Dir) + '.credentials.yaml') or
             DirExists(AddBackslash(Dir) + 'sessions') or
             DirExists(AddBackslash(Dir) + 'profiles'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Dir, Marker, InstallPath: String;
begin
  { Windows itself records the app in these places the first time it runs; remove those traces too. }
  if CurUninstallStep = usPostUninstall then
  begin
    RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Search\JumplistData',
                   ExpandConstant('{app}\{#AppExe}'));
    RegDeleteKeyIncludingSubkeys(HKCU,
      'Software\Microsoft\Windows\CurrentVersion\Start\TileProperties\W~' + ExpandConstant('{app}'));

    { Only when the install folder never held runtime/data: otherwise this app used its own
      folder, and the LocalAppData copy may belong to another installation. }
    if DeleteFallbackData then
    begin
      Dir := ExpandConstant('{%LOCALAPPDATA}') + '\DshLauncher';
      if (not IsRootPath(Dir)) and
         (DirExists(AddBackslash(Dir) + 'runtime') or DirExists(AddBackslash(Dir) + 'data')) then
        DelTree(Dir, True, True, True);
    end;
  end;

  if CurUninstallStep = usUninstall then
  begin
    { The app writes install-path.ini in the fallback folder. Delete that folder only when the
      marker names this install and the install folder itself never held runtime/data. }
    DeleteFallbackData := False;
    if (not DirExists(ExpandConstant('{app}\runtime'))) and
       (not DirExists(ExpandConstant('{app}\data'))) then
    begin
      Marker := ExpandConstant('{%LOCALAPPDATA}') + '\DshLauncher\install-path.ini';
      if FileExists(Marker) then
      begin
        InstallPath := GetIniString('install', 'path', '', Marker);
        if InstallPath <> '' then
        begin
          InstallPath := RemoveBackslashUnlessRoot(Trim(InstallPath));
          DeleteFallbackData :=
            LowerCase(InstallPath) = LowerCase(RemoveBackslashUnlessRoot(ExpandConstant('{app}')));
        end;
      end;
    end;

    Dir := DshHomeDir();
    if (not UninstallSilent) and LooksLikeDshHome(Dir) then
    begin
      if MsgBox('Also delete your DeepSeek data?' + #13#10 + #13#10 +
                'This removes your chats, settings and saved API key stored in:' + #13#10 + Dir + #13#10 + #13#10 +
                'This cannot be undone. Choose No if you plan to reinstall or use ' +
                'DeepSeek Harness elsewhere.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(Dir, True, True, True);
    end;
  end;
end;
