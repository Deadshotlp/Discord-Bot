# Deployment: Dashboard hinter nginx

Anleitung für `bot.deadshot-development.de` mit dem Bot im
Pterodactyl-Container und nginx als Reverse Proxy davor.

---

## 1. Voraussetzungen

**DNS:** Ein A-Record (und bei IPv6 zusätzlich AAAA) für
`bot.deadshot-development.de` muss auf die IP des Webservers zeigen, auf dem
nginx läuft. Ohne das schlägt die Zertifikatsausstellung fehl.

Prüfen:

```bash
dig +short bot.deadshot-development.de
```

Die Ausgabe muss die Server-IP sein. Nach einer DNS-Änderung kann es bis zur
TTL dauern.

**Port des Containers:** Im Pterodactyl-Panel unter *Server → Netzwerk* steht
die Allocation als `IP:Port`. Diesen Port brauchst du unten zweimal.

---

## 2. Bot im Container konfigurieren

In der `.env` des Containers:

```dotenv
WEB_ENABLED=true
WEB_HOST=0.0.0.0
WEB_PORT=<Allocation-Port aus dem Panel>
WEB_BASE_URL=https://bot.deadshot-development.de

# Ohne das läuft der Bot in UTC – Termine und Tagesgrenzen wären verschoben.
BOT_TIMEZONE=Europe/Berlin

DISCORD_CLIENT_ID=<aus dem Developer Portal>
DISCORD_CLIENT_SECRET=<aus dem Developer Portal>
```

`WEB_HOST=0.0.0.0` ist nötig, damit der Prozess an die Allocation gebunden wird –
auf `127.0.0.1` wäre er aus dem Container heraus nicht erreichbar.

`WEB_BASE_URL` steuert zwei Dinge: die Redirect-URL für den Discord-Login und
ob Session-Cookies als `Secure` gesetzt werden. Deshalb muss dort `https://`
stehen, sobald das Zertifikat aktiv ist.

Im **Discord Developer Portal → OAuth2 → Redirects** eintragen:

```text
https://bot.deadshot-development.de/api/auth/callback
```

Danach den Server im Panel neu starten. In der Konsole muss stehen:
`Web-Dashboard läuft`.

---

## 3. nginx-Site anlegen

Datei `/etc/nginx/sites-available/bot.deadshot-development.de`:

```nginx
server {
    listen 80;
    listen [::]:80;

    server_name bot.deadshot-development.de;

    access_log /var/log/nginx/bot.access.log;
    error_log  /var/log/nginx/bot.error.log;

    # Das Dashboard begrenzt Request-Bodies selbst auf 1 MB.
    client_max_body_size 1m;

    location / {
        # IP:Port der Pterodactyl-Allocation eintragen.
        proxy_pass http://127.0.0.1:<PORT>;

        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 5s;
        proxy_read_timeout    60s;
    }
}
```

Aktivieren und prüfen:

```bash
sudo ln -s /etc/nginx/sites-available/bot.deadshot-development.de /etc/nginx/sites-enabled/
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` muss `syntax is ok` und `test is successful` melden. Erst dann
reloaden – ein Reload mit fehlerhafter Config lässt nginx im alten Zustand,
ein Restart würde ihn dagegen stoppen.

Test ohne TLS:

```bash
curl -s http://bot.deadshot-development.de/api/health
```

Erwartet wird JSON mit `"ok":true`. Kommt stattdessen `502 Bad Gateway`,
stimmt `proxy_pass` nicht – siehe Abschnitt 6.

---

## 4. Zertifikat mit Certbot

```bash
sudo certbot --nginx -d bot.deadshot-development.de
```

Certbot ergänzt den `server`-Block selbstständig um `listen 443 ssl`, die
Zertifikatspfade und einen HTTP-nach-HTTPS-Redirect. Die Datei danach nicht
mehr von Hand umbauen, sonst kollidiert es mit der automatischen Erneuerung.

Ist Certbot nicht installiert (Debian/Ubuntu):

```bash
sudo apt install certbot python3-certbot-nginx
```

Automatische Erneuerung testen:

```bash
sudo certbot renew --dry-run
```

Danach prüfen:

```bash
curl -s https://bot.deadshot-development.de/api/health
```

---

## 5. Sicherheitshinweis zur Allocation

Zeigt die Pterodactyl-Allocation auf die **öffentliche** IP des Nodes, ist das
Dashboard zusätzlich direkt unter `http://<IP>:<PORT>` erreichbar – unverschlüsselt
und an nginx vorbei. Zwei Möglichkeiten:

- Im Panel eine Allocation auf `127.0.0.1` verwenden (sauberste Lösung), oder
- den Port von außen sperren:

```bash
sudo ufw deny <PORT>/tcp
```

Läuft nginx auf einem **anderen** Server als der Container, muss der Port
erreichbar bleiben. Dann `proxy_pass` auf die Node-IP setzen und den Zugriff
per Firewall auf die IP des Webservers beschränken.

---

## 6. Wenn etwas nicht läuft

| Symptom | Ursache | Prüfen |
| --- | --- | --- |
| `502 Bad Gateway` | Bot läuft nicht oder falscher Port | `curl http://127.0.0.1:<PORT>/api/health` direkt auf dem Server |
| `502`, Bot läuft aber | Bindet an `127.0.0.1` statt an die Allocation | `WEB_HOST=0.0.0.0` in der `.env` |
| Login-Schleife | Redirect-URL passt nicht | `WEB_BASE_URL` und Discord-Portal müssen exakt übereinstimmen, ohne Slash am Ende |
| „Ungültige Anfrage-Herkunft“ | Cookie kommt nicht an | `WEB_BASE_URL` muss `https://` sein, sobald TLS aktiv ist |
| Certbot scheitert | DNS zeigt nicht auf den Server | `dig +short bot.deadshot-development.de` |
| Dashboard leer, Konsole meldet 401 | Session abgelaufen | neu anmelden |

Logs:

```bash
sudo tail -f /var/log/nginx/bot.error.log
```

---

## 7. Alte Site ablösen

Die Schritte zum Entfernen einer nicht mehr genutzten Site stehen in
[`SITE-ENTFERNEN.md`](SITE-ENTFERNEN.md).
