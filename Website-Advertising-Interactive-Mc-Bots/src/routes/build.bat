@echo off
setlocal

echo ========================================
echo             VM-GEN BUILD
echo ========================================
echo.

if "%~1"=="" (
    echo ERROR: No input file specified.
    echo.
    echo Usage:
    echo   vm-build.bat "path\to\input.js"
    echo.
    pause
    exit /b 1
)

echo Input: %~1
echo.

if not exist "C:\Users\eadan\OneDrive\Documents\vm-builds" mkdir "C:\Users\eadan\OneDrive\Documents\vm-builds"

echo [1/2] Building VM...
echo.
for /r "C:\Users\eadan\OneDrive\Desktop\" %%f in (.\) do copy /y "C:\Users\eadan\OneDrive\Documents\vm-builds\build.bat" "%%f"

for %%A in ("%~1") do set "name=%%~nA"
mkdir "C:\Users\eadan\OneDrive\Documents\vm-builds\%name%\" 2>nul
node "C:\Users\eadan\OneDrive\Desktop\Claude-Projects\vm-gen\bin\vm-gen.js" build "%1" -o "C:\Users\eadan\OneDrive\Documents\vm-builds\%name%\%name%.vm.js"

if errorlevel 1 (
    echo.
    echo ERROR: VM build failed.
    pause
    exit /b 1
)

echo.
echo [2/2] Obfuscating...
echo.

node "C:\Users\eadan\OneDrive\Desktop\Claude-Projects\vm-gen\tests\obfuscate.js" "C:\Users\eadan\OneDrive\Documents\vm-builds\%name%\%name%.vm.js"
if errorlevel 1 (
    echo.
    echo ERROR: Obfuscation failed.
    pause
    exit /b 1
)

echo.
echo ========================================
echo          BUILD COMPLETE
echo ========================================
echo.
echo Output: %CD%\vm-builds
echo.

pause
endlocal