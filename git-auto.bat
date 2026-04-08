@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo.
echo === git status (antes) ===
git status
if errorlevel 1 goto :err

echo.
echo === git add -A ===
git add -A
if errorlevel 1 goto :err

set "MSG="
set "MSGFILE=%TEMP%\git_commit_msg_%RANDOM%.txt"

rem Lê mensagem via PowerShell e remove caracteres de controle (ex: Ctrl+A vira ^A)
for /f "usebackq delims=" %%M in (`powershell -NoProfile -Command "$m = Read-Host 'Mensagem commit'; $m = ($m -replace '[\x00-\x1F]','').Trim(); if(-not $m){$m='update'}; $m"`) do (
  set "MSG=%%M"
)

rem Escreve em arquivo (evita problemas com aspas/símbolos)
powershell -NoProfile -Command "$m = '%MSG%'; $m | Out-File -FilePath '%MSGFILE%' -Encoding utf8"

echo.
echo === git commit ===
git commit -F "%MSGFILE%"
del "%MSGFILE%" >nul 2>&1
if errorlevel 1 (
  echo.
  echo Commit falhou ou nada para commitar.
  echo Se "nothing to commit", ignorar.
)

echo.
echo === git push ===
git push
if errorlevel 1 goto :err

echo.
echo OK.
goto :eof

:err
echo.
echo ERRO.
exit /b 1

