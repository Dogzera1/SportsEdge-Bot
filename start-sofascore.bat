@echo off
cd /d "%~dp0Public-Sofascore-API"
call venv\Scripts\activate.bat
cd sofascore_service
python manage.py runserver 8000
pause
