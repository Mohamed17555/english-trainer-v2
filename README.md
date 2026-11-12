# English Trainer Pro

## تشغيل على جهازك (الأضمن)
1. ثبّت Node 18+ (واختياريًا yt-dlp).
2. `node captions-server.js`
3. افتح http://localhost:8787 — في الموقع اكتب في خانة الخادم: `/captions`

## نشر على الإنترنت (Render)
1. ارفع الفولدر ده على GitHub.
2. في render.com: New → Blueprint (أو Web Service → Docker) واختر الريبو.
3. بعد النشر افتح رابط الموقع، واكتب في خانة الخادم: `/captions`

ملاحظة: يوتيوب كثيرًا يحجب الاستضافات السحابية؛ إن فشل الجلب استخدم اللصق اليدوي.
