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
set /p MSG=Mensagem commit: 
if "%MSG%"=="" set "MSG=update"

echo.
echo === git commit ===
git commit -m "%MSG%"
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

