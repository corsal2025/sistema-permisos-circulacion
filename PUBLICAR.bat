@echo off
REM Compila el servidor .NET y arma la carpeta SISTEMA lista para usar.
REM Requiere .NET 10 SDK solo en el PC que compila; el resultado no requiere instalar nada.
cd /d "%~dp0"
dotnet publish servidor\Servidor.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none -o SISTEMA || goto :error
if not exist SISTEMA\web mkdir SISTEMA\web
copy /Y dashboard\index.html SISTEMA\web\index.html >nul
xcopy /Y /I /Q dashboard\vendor SISTEMA\web\vendor >nul
if exist dashboard\data.js copy /Y dashboard\data.js SISTEMA\data.js >nul
if exist SISTEMA\web.config del SISTEMA\web.config
(echo @echo off& echo cd /d "%%~dp0"& echo CorrespondenciaPC.exe) > SISTEMA\INICIAR.bat
(echo @echo off& echo REM Permite que otros PCs entren: http://IP-DE-ESTE-PC:8765& echo cd /d "%%~dp0"& echo ipconfig ^| findstr /i "IPv4"& echo CorrespondenciaPC.exe --red) > "SISTEMA\INICIAR EN RED.bat"
echo.
echo Listo. Carpeta SISTEMA actualizada. Si solo cambiaste index.html, basta con recargar el navegador.
pause
exit /b 0
:error
echo Error al compilar.
pause
exit /b 1
