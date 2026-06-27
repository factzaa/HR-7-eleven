@echo off
REM ============================================================
REM  7-Eleven HR System - Local Server Launcher
REM  ดับเบิลคลิกไฟล์นี้เพื่อเริ่มเซิร์ฟเวอร์ แล้วเปิดเบราว์เซอร์อัตโนมัติ
REM ============================================================
cd /d "%~dp0"

REM หา python หรือ py
where python >nul 2>nul
if %errorlevel%==0 (set PY=python) else (set PY=py)

echo ============================================================
echo   7-Eleven HR System
echo ------------------------------------------------------------
echo   Employee : http://localhost:8000/employee/
echo   HR       : http://localhost:8000/hr/   (password: admin1234)
echo ------------------------------------------------------------
echo   ปิดเซิร์ฟเวอร์ = ปิดหน้าต่างนี้ หรือกด Ctrl+C
echo ============================================================

REM เปิดเบราว์เซอร์ไปที่หน้าพนักงาน
start "" http://localhost:8000/employee/

REM เริ่มเซิร์ฟเวอร์
%PY% -m http.server 8000

pause
