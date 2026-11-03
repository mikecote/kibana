@echo off

SETLOCAL ENABLEDELAYEDEXPANSION

set SCRIPT_DIR=%~dp0
for %%I in ("%SCRIPT_DIR%..") do set DIR=%%~dpfI

set NODE=%DIR%\node\default\node.exe
set NODE_ENV=production
set NODE_OPTIONS=--max-semi-space-size=8 --max-old-space-size=512

If Not Exist "%NODE%" (
  Echo unable to find usable node.js executable.
  Exit /B 1
)

If "%~1" == "" (
  Echo usage: kibana-task ^<task_type^|bundle^>
  Exit /B 64
)

for /F "usebackq delims=" %%B in (`"%NODE%" -e "const [dir, wanted] = process.argv.slice(1); const { bundles } = require(dir + '/task_bundles/manifest.json'); const name = Object.keys(bundles).find((n) => n === wanted || bundles[n].taskTypes.includes(wanted)); if (name) process.stdout.write(dir + '/task_bundles/' + bundles[name].file);" "%DIR%" "%~1"`) do set BUNDLE=%%B

If "%BUNDLE%" == "" (
  Echo no task bundle serves '%~1'
  Exit /B 66
)

"%NODE%" "%BUNDLE%"

:finally

ENDLOCAL
