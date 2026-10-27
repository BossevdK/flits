package nl.flits.app

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import fi.iki.elonen.NanoHTTPD
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.URL
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import javax.net.ssl.HttpsURLConnection
import kotlin.concurrent.thread

/**
 * Hart van Flits op Android: apparaten vinden (UDP), ontvangen (HTTPS-server) en versturen.
 * Spreekt hetzelfde protocol als de Windows-app (zie windows/src/core.js).
 */
object Engine {
    const val PORT = 53317
    const val DISCOVERY_PORT = 53318
    private const val PEER_TTL = 10_000L
    private const val OFFER_TIMEOUT_S = 60L

    private lateinit var ctx: Context
    private var inited = false
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // ---- staat voor de UI ----
    val peers = MutableStateFlow<List<Peer>>(emptyList())
    val transfers = MutableStateFlow<List<Transfer>>(emptyList())
    val offers = MutableStateFlow<List<Transfer>>(emptyList())
    val messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val settings = MutableStateFlow(Settings())
    val ips = MutableStateFlow<List<String>>(emptyList())
    val running = MutableStateFlow(false)
    @Volatile var appVisible = false

    data class Settings(
        val deviceName: String = "",
        val autoAcceptAll: Boolean = false,
        val background: Boolean = true,
        val trustedCount: Int = 0,
    )

    private class Decision(val accept: Boolean, val remember: Boolean = false, val gone: Boolean = false)
    private class Session(val token: String, val live: Live) {
        @Volatile var cancelled = false
        @Volatile var finished = 0
    }
    private class Outgoing { @Volatile var cancelled = false; @Volatile var conn: HttpsURLConnection? = null; @Volatile var token: String? = null; lateinit var peer: Peer }

    private val lives = LinkedHashMap<String, Live>()
    private val pending = ConcurrentHashMap<String, CompletableFuture<Decision>>()
    private val pendingLive = ConcurrentHashMap<String, Live>()
    private val sessions = ConcurrentHashMap<String, Session>()
    private val outgoing = ConcurrentHashMap<String, Outgoing>()
    private val peerMap = ConcurrentHashMap<String, Peer>()
    private val manualHosts = ConcurrentHashMap<String, Pair<String, Int>>()
    @Volatile private var lastPublish = 0L

    private var server: NanoHTTPD? = null
    private var udp: DatagramSocket? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private val prefs get() = ctx.getSharedPreferences("flits", Context.MODE_PRIVATE)
    val deviceId: String get() = prefs.getString("id", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("id", it).apply() }
    private val trusted: MutableSet<String> get() = prefs.getStringSet("trusted", emptySet())!!.toMutableSet()

    // ---------- opstarten ----------
    @Synchronized
    fun init(context: Context) {
        if (inited) return
        ctx = context.applicationContext
        inited = true
        val default = Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android"
        settings.value = Settings(
            deviceName = prefs.getString("name", null) ?: default,
            autoAcceptAll = prefs.getBoolean("autoAcceptAll", false),
            background = prefs.getBoolean("background", true),
            trustedCount = trusted.size,
        )
        prefs.getString("history", null)?.let { s ->
            runCatching {
                val arr = JSONArray(s)
                val list = (0 until arr.length()).map { Transfer.fromJson(arr.getJSONObject(it)) }
                transfers.value = list
            }
        }
        Notifier.init(ctx)
        refreshIps()
    }

    @Synchronized
    fun start() {
        if (running.value) return
        try {
            val (keyStore, keyManagers) = Tls.load(ctx)
            val factory = NanoHTTPD.makeSSLSocketFactory(keyStore, keyManagers)
            val s = FlitsServer(PORT)
            s.makeSecure(factory, null)
            s.start(120_000, false)
            server = s
        } catch (e: Exception) {
            messages.tryEmit("Kan de ontvanger niet starten: ${e.message}")
            return
        }
        val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicastLock = wm.createMulticastLock("flits-mc").apply { setReferenceCounted(false); runCatching { acquire() } }
        startDiscovery()
        running.value = true
        scope.launch {
            while (isActive && running.value) {
                announce(); delay(3000)
            }
        }
        scope.launch {
            while (isActive && running.value) {
                prune(); pollManual(); refreshIps(); delay(2000)
            }
        }
    }

    @Synchronized
    fun stop() {
        if (!running.value) return
        running.value = false
        runCatching { server?.stop() }; server = null
        runCatching { udp?.close() }; udp = null
        runCatching { multicastLock?.release() }; multicastLock = null
        releaseTransferLocks()
        peerMap.clear(); peers.value = emptyList()
    }

    fun hasActiveTransfers() = synchronized(lives) { lives.values.any { it.status == Status.WAITING || it.status == Status.ACTIVE } }

    // ---------- instellingen ----------
    fun setDeviceName(name: String) {
        val n = name.trim().take(40)
        if (n.isEmpty()) return
        prefs.edit().putString("name", n).apply()
        settings.value = settings.value.copy(deviceName = n)
        announce()
    }

    fun setAutoAccept(v: Boolean) { prefs.edit().putBoolean("autoAcceptAll", v).apply(); settings.value = settings.value.copy(autoAcceptAll = v) }
    fun setBackground(v: Boolean) { prefs.edit().putBoolean("background", v).apply(); settings.value = settings.value.copy(background = v) }
    fun forgetTrusted() { prefs.edit().remove("trusted").apply(); settings.value = settings.value.copy(trustedCount = 0) }

    private fun refreshIps() {
        val list = mutableListOf<String>()
        runCatching {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                for (a in ni.inetAddresses) if (a is java.net.Inet4Address && !a.isLoopbackAddress) list += a.hostAddress ?: continue
            }
        }
        if (list != ips.value) ips.value = list
    }

    // ---------- apparaten vinden ----------
    private fun infoJson() = JSONObject().put("id", deviceId).put("name", settings.value.deviceName).put("type", "android").put("port", PORT)

    private fun packet(): ByteArray = infoJson().put("app", "flits").put("v", 1).toString().toByteArray()

    private fun startDiscovery() {
        val sock = DatagramSocket(null).apply { reuseAddress = true; broadcast = true; bind(InetSocketAddress(DISCOVERY_PORT)) }
        udp = sock
        thread(name = "flits-udp", isDaemon = true) {
            val buf = ByteArray(2048)
            while (!sock.isClosed) {
                try {
                    val p = DatagramPacket(buf, buf.size)
                    sock.receive(p)
                    val m = JSONObject(String(p.data, 0, p.length))
                    if (m.optString("app") != "flits") continue
                    val id = m.optString("id")
                    if (id.isEmpty() || id == deviceId) continue
                    val isNew = !peerMap.containsKey(id)
                    upsertPeer(Peer(id, m.optString("name", "Onbekend"), m.optString("type", "other"), p.address.hostAddress ?: continue, m.optInt("port", PORT)))
                    if (isNew) runCatching { sock.send(DatagramPacket(packet(), packet().size, p.address, DISCOVERY_PORT)) }
                } catch (e: Exception) {
                    if (sock.isClosed) break
                }
            }
        }
    }

    private fun announce() {
        val sock = udp ?: return
        val data = packet()
        val targets = mutableSetOf("255.255.255.255")
        runCatching {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in ni.interfaceAddresses) ia.broadcast?.hostAddress?.let { targets += it }
            }
        }
        for (t in targets) runCatching { sock.send(DatagramPacket(data, data.size, InetAddress.getByName(t), DISCOVERY_PORT)) }
    }

    private fun upsertPeer(p: Peer) {
        val old = peerMap[p.id]
        peerMap[p.id] = p
        if (old == null || old.name != p.name || old.ip != p.ip || old.port != p.port) publishPeers()
    }

    private fun publishPeers() { peers.value = peerMap.values.sortedBy { it.name.lowercase() } }

    private fun prune() {
        val now = System.currentTimeMillis()
        val gone = peerMap.values.filter { now - it.lastSeen > PEER_TTL }
        if (gone.isNotEmpty()) { gone.forEach { peerMap.remove(it.id) }; publishPeers() }
    }

    fun addManual(hostText: String): String? {
        val parts = hostText.trim().split(":")
        val ip = parts[0]
        val port = parts.getOrNull(1)?.toIntOrNull() ?: PORT
        if (!Regex("""\d{1,3}(\.\d{1,3}){3}""").matches(ip)) return "Geen geldig IP-adres"
        val info = runCatching { fetchInfo(ip, port) }.getOrNull() ?: return "Geen Flits gevonden op dit adres"
        manualHosts["$ip:$port"] = ip to port
        upsertPeer(Peer(info.getString("id"), info.optString("name", "Onbekend"), info.optString("type", "other"), ip, port))
        return null
    }

    private fun fetchInfo(ip: String, port: Int): JSONObject {
        val c = open(Peer("", "", "", ip, port), "/info", "GET", timeout = 4000)
        try {
            if (c.responseCode != 200) throw IOException("status ${c.responseCode}")
            return JSONObject(c.inputStream.readBytes().toString(Charsets.UTF_8))
        } finally { c.disconnect() }
    }

    private fun pollManual() {
        for ((ip, port) in manualHosts.values) {
            runCatching {
                val i = fetchInfo(ip, port)
                if (i.optString("id") != deviceId) upsertPeer(Peer(i.getString("id"), i.optString("name", "Onbekend"), i.optString("type", "other"), ip, port))
            }
        }
    }

    // ---------- bijhouden van overdrachten ----------
    private fun register(l: Live) { synchronized(lives) { lives[l.id] = l }; publish(true) }

    private fun publish(force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastPublish < 120) return
        lastPublish = now
        val live = synchronized(lives) { lives.values.map { it.snapshot() } }
        val liveIds = live.map { it.id }.toSet()
        val old = transfers.value.filter { it.id !in liveIds }
        transfers.value = (live + old).sortedByDescending { it.startedAt }.take(40)
    }

    private fun finish(l: Live, status: Status, error: String? = null) {
        if (l.status == Status.DONE || l.status == Status.ERROR || l.status == Status.DECLINED || l.status == Status.CANCELLED) return
        l.status = status; l.error = error; l.speed = 0.0; l.finishedAt = System.currentTimeMillis()
        publish(true)
        if (!hasActiveTransfers()) releaseTransferLocks()
        saveHistory()
    }

    private fun saveHistory() {
        val done = transfers.value.filter { !it.isLive }.take(30)
        val arr = JSONArray(); done.forEach { arr.put(it.toJson()) }
        prefs.edit().putString("history", arr.toString()).apply()
    }

    fun clearHistory() {
        synchronized(lives) { lives.values.removeAll { it.status != Status.WAITING && it.status != Status.ACTIVE } }
        transfers.value = transfers.value.filter { it.isLive }
        prefs.edit().remove("history").apply()
    }

    private fun acquireTransferLocks() {
        runCatching {
            if (wifiLock == null) {
                val wm = ctx.getSystemService(Context.WIFI_SERVICE) as WifiManager
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "flits-wifi").apply { setReferenceCounted(false); acquire() }
            }
            if (wakeLock == null) {
                val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flits:transfer").apply { setReferenceCounted(false); acquire(60 * 60 * 1000L) }
            }
        }
    }

    private fun releaseTransferLocks() {
        runCatching { wifiLock?.release() }; wifiLock = null
        runCatching { wakeLock?.release() }; wakeLock = null
    }

    // ---------- ontvangen: server ----------
    private class FlitsServer(port: Int) : NanoHTTPD(port) {
        override fun serve(session: IHTTPSession): Response {
            val r = try { route(session) } catch (e: Exception) { jsonResp(Response.Status.INTERNAL_ERROR, JSONObject().put("error", e.message ?: "fout")) }
            r.closeConnection(true)
            return r
        }
    }

    private fun jsonResp(status: NanoHTTPD.Response.IStatus, o: JSONObject): NanoHTTPD.Response =
        NanoHTTPD.newFixedLengthResponse(status, "application/json", o.toString())

    private fun route(s: NanoHTTPD.IHTTPSession): NanoHTTPD.Response {
        val uri = s.uri
        val method = s.method
        if (method == NanoHTTPD.Method.GET && uri == "/info") return jsonResp(NanoHTTPD.Response.Status.OK, infoJson())
        if (method == NanoHTTPD.Method.POST && uri == "/offer") return handleOffer(s)
        Regex("""^/upload/([\w-]+)/(\d+)$""").matchEntire(uri)?.let {
            if (method == NanoHTTPD.Method.PUT) return handleUpload(s, it.groupValues[1], it.groupValues[2].toInt())
        }
        Regex("""^/cancel/([\w-]+)$""").matchEntire(uri)?.let {
            if (method == NanoHTTPD.Method.POST) {
                val key = it.groupValues[1]
                sessions[key]?.let { ses -> ses.cancelled = true; finish(ses.live, Status.CANCELLED, "De afzender heeft geannuleerd"); sessions.remove(key) }
                pendingLive.values.firstOrNull { l -> l.remoteOfferId == key }?.let { l -> pending[l.id]?.complete(Decision(false, gone = true)) }
                return jsonResp(NanoHTTPD.Response.Status.OK, JSONObject().put("ok", true))
            }
        }
        return jsonResp(NanoHTTPD.Response.Status.NOT_FOUND, JSONObject().put("error", "onbekend"))
    }

    private fun readBody(s: NanoHTTPD.IHTTPSession, limit: Int = 1_000_000): String {
        val len = s.headers["content-length"]?.toIntOrNull() ?: 0
        if (len <= 0 || len > limit) return "{}"
        val buf = ByteArray(len)
        var off = 0
        while (off < len) {
            val n = s.inputStream.read(buf, off, len - off)
            if (n < 0) break
            off += n
        }
        return String(buf, 0, off, Charsets.UTF_8)
    }

    private fun safeSegment(s: String): String {
        var out = s.replace(Regex("""[<>:"\\|?*\u0000-\u001f]"""), "_").trim().trimStart('.').trimEnd('.', ' ')
        if (out.isEmpty()) out = "bestand"
        return out
    }

    private fun safeRel(name: String): String =
        name.split('/', '\\').filter { it.isNotEmpty() && it != "." && it != ".." }.joinToString("/") { safeSegment(it) }.ifEmpty { "bestand" }

    private fun handleOffer(s: NanoHTTPD.IHTTPSession): NanoHTTPD.Response {
        val body = JSONObject(readBody(s))
        val sender = body.optJSONObject("sender") ?: return jsonResp(NanoHTTPD.Response.Status.BAD_REQUEST, JSONObject().put("error", "geen afzender"))
        val filesJson = body.optJSONArray("files") ?: JSONArray()
        val text = if (body.has("text") && !body.isNull("text")) body.getString("text").take(200_000) else null
        if (sender.optString("id").isEmpty() || (filesJson.length() == 0 && text == null)) return jsonResp(NanoHTTPD.Response.Status.BAD_REQUEST, JSONObject().put("error", "ongeldig aanbod"))

        val files = (0 until minOf(filesJson.length(), 5000)).map { i ->
            val f = filesJson.getJSONObject(i)
            LiveFile(i, safeRel(f.optString("name", "bestand")), maxOf(0L, f.optLong("size")))
        }
        val live = Live(UUID.randomUUID().toString(), true, sender.getString("id"), sender.optString("name", "Onbekend"), sender.optString("type", "other"), files, text)
        live.remoteOfferId = body.optString("offerId").ifEmpty { null }
        register(live)

        val st = settings.value
        val decision: Decision
        if (st.autoAcceptAll || trusted.contains(live.peerId)) {
            decision = Decision(true)
        } else {
            val fut = CompletableFuture<Decision>()
            pending[live.id] = fut
            pendingLive[live.id] = live
            offers.value = offers.value + live.snapshot()
            Notifier.offer(live.snapshot(), appVisible)
            decision = try { fut.get(OFFER_TIMEOUT_S, TimeUnit.SECONDS) } catch (e: TimeoutException) { Decision(false) } catch (e: Exception) { Decision(false, gone = true) }
            pending.remove(live.id); pendingLive.remove(live.id)
            offers.value = offers.value.filter { it.id != live.id }
            Notifier.cancelOffer(live.id)
        }

        if (!decision.accept) {
            finish(live, if (decision.gone) Status.CANCELLED else Status.DECLINED)
            return jsonResp(NanoHTTPD.Response.Status.OK, JSONObject().put("accepted", false))
        }
        if (decision.remember) {
            prefs.edit().putStringSet("trusted", trusted.apply { add(live.peerId) }).apply()
            settings.value = settings.value.copy(trustedCount = trusted.size)
        }
        if (files.isEmpty()) {
            finish(live, Status.DONE)
            Notifier.text(live.snapshot())
            return jsonResp(NanoHTTPD.Response.Status.OK, JSONObject().put("accepted", true).put("token", JSONObject.NULL))
        }
        val token = UUID.randomUUID().toString()
        sessions[token] = Session(token, live)
        live.status = Status.ACTIVE
        acquireTransferLocks()
        publish(true)
        return jsonResp(NanoHTTPD.Response.Status.OK, JSONObject().put("accepted", true).put("token", token))
    }

    fun respondOffer(id: String, accept: Boolean, remember: Boolean) {
        pending[id]?.complete(Decision(accept, remember))
    }

    private fun mimeOf(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    private fun createDownload(rel: String): Pair<Uri, OutputStream> {
        val dir = rel.substringBeforeLast('/', "")
        val name = rel.substringAfterLast('/')
        val v = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mimeOf(name))
            put(MediaStore.Downloads.RELATIVE_PATH, "Download/Flits" + if (dir.isNotEmpty()) "/$dir" else "")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: throw IOException("Kan geen bestand aanmaken in Downloads")
        val out = ctx.contentResolver.openOutputStream(uri) ?: throw IOException("Kan niet naar Downloads schrijven")
        return uri to out
    }

    private fun handleUpload(s: NanoHTTPD.IHTTPSession, token: String, fileId: Int): NanoHTTPD.Response {
        val ses = sessions[token] ?: return jsonResp(NanoHTTPD.Response.Status.NOT_FOUND, JSONObject().put("error", "onbekende sessie"))
        val live = ses.live
        val lf = live.files.getOrNull(fileId) ?: return jsonResp(NanoHTTPD.Response.Status.NOT_FOUND, JSONObject().put("error", "onbekend bestand"))
        val len = s.headers["content-length"]?.toLongOrNull() ?: -1L
        if (len != lf.size) return jsonResp(NanoHTTPD.Response.Status.BAD_REQUEST, JSONObject().put("error", "grootte klopt niet"))

        var created: Pair<Uri, OutputStream>? = null
        try {
            created = createDownload(lf.name)
            val (uri, out) = created
            val input = s.inputStream
            val buf = ByteArray(128 * 1024)
            var remaining = len
            val meter = Meter(live)
            while (remaining > 0) {
                if (ses.cancelled) throw IOException("Geannuleerd")
                val n = input.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                if (n < 0) throw IOException("Verbinding onderbroken")
                out.write(buf, 0, n)
                remaining -= n
                lf.done += n
                live.done += n
                meter.add(n)
                publish()
            }
            out.close()
            ctx.contentResolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            live.savedUris.add(uri.toString())
            ses.finished++
            if (ses.finished == live.files.size) {
                sessions.remove(token)
                finish(live, Status.DONE)
                Notifier.received(live.snapshot())
            } else publish(true)
            return jsonResp(NanoHTTPD.Response.Status.OK, JSONObject().put("ok", true))
        } catch (e: Exception) {
            runCatching { created?.second?.close() }
            created?.first?.let { runCatching { ctx.contentResolver.delete(it, null, null) } }
            sessions.remove(token)
            finish(live, if (ses.cancelled) Status.CANCELLED else Status.ERROR, if (ses.cancelled) "Geannuleerd" else (e.message ?: "Overdracht mislukt"))
            return jsonResp(NanoHTTPD.Response.Status.INTERNAL_ERROR, JSONObject().put("error", e.message ?: "fout"))
        }
    }

    // ---------- versturen ----------
    private fun open(peer: Peer, path: String, method: String, timeout: Int = 15000, readTimeout: Int = timeout): HttpsURLConnection {
        val c = URL("https://${peer.ip}:${peer.port}$path").openConnection() as HttpsURLConnection
        c.sslSocketFactory = Tls.clientFactory
        c.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        c.requestMethod = method
        c.connectTimeout = timeout
        c.readTimeout = readTimeout
        c.useCaches = false
        return c
    }

    private fun friendly(e: Throwable): String {
        val m = e.message ?: e.javaClass.simpleName
        return when {
            e is java.net.SocketTimeoutException || e is java.net.ConnectException || e is java.net.NoRouteToHostException ||
                e is java.net.UnknownHostException -> "Kan het andere apparaat niet bereiken. Staan beide op hetzelfde wifi?"
            e is java.net.SocketException -> "Verbinding onderbroken"
            else -> m
        }
    }

    fun queryFile(uri: Uri): Pair<String, Long> {
        var name = uri.lastPathSegment ?: "bestand"
        var size = -1L
        runCatching {
            ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getString(0)?.let { name = it }
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        }
        return name to size
    }

    fun sendText(peerId: String, text: String): String? {
        val peer = peerMap[peerId] ?: return "Apparaat niet meer gevonden"
        if (text.isBlank()) return "Niets om te sturen"
        val live = Live(UUID.randomUUID().toString(), false, peer.id, peer.name, peer.type, emptyList(), text)
        register(live)
        scope.launch { runSend(peer, live, emptyList()) }
        return null
    }

    fun sendFiles(peerId: String, uris: List<Uri>): String? {
        val peer = peerMap[peerId] ?: return "Apparaat niet meer gevonden"
        if (uris.isEmpty()) return "Geen bestanden gekozen"
        scope.launch {
            val files = uris.mapIndexed { i, u ->
                val (n, sz) = queryFile(u)
                if (sz >= 0) LiveFile(i, n, sz, u) else {
                    // Zonder bekende grootte eerst naar de cache kopiëren: HTTP heeft de lengte vooraf nodig.
                    val tmp = File.createTempFile("flits", ".tmp", ctx.cacheDir)
                    ctx.contentResolver.openInputStream(u)?.use { ins -> tmp.outputStream().use { o -> ins.copyTo(o) } }
                    LiveFile(i, n, tmp.length(), Uri.fromFile(tmp))
                }
            }
            val live = Live(UUID.randomUUID().toString(), false, peer.id, peer.name, peer.type, files, null)
            register(live)
            runSend(peer, live, files)
        }
        return null
    }

    private fun runSend(peer: Peer, live: Live, files: List<LiveFile>) {
        val out = Outgoing().also { it.peer = peer }
        outgoing[live.id] = out
        acquireTransferLocks()
        try {
            val offer = JSONObject()
                .put("offerId", live.id)
                .put("sender", infoJson())
                .put("files", JSONArray().also { a -> files.forEach { a.put(JSONObject().put("name", it.name).put("size", it.size)) } })
            if (live.text != null) offer.put("text", live.text)

            val c = open(peer, "/offer", "POST", timeout = 8000, readTimeout = ((OFFER_TIMEOUT_S + 15) * 1000).toInt())
            out.conn = c
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            val data = offer.toString().toByteArray()
            c.setFixedLengthStreamingMode(data.size)
            c.outputStream.use { it.write(data) }
            val code = c.responseCode
            val resp = JSONObject(c.inputStream.readBytes().toString(Charsets.UTF_8))
            c.disconnect()
            if (out.cancelled) return
            if (code != 200 || !resp.optBoolean("accepted")) { finish(live, Status.DECLINED); return }
            if (files.isEmpty()) { finish(live, Status.DONE); return }

            val token = resp.getString("token")
            out.token = token
            live.status = Status.ACTIVE
            publish(true)
            val meter = Meter(live)
            for (lf in files) {
                if (out.cancelled) return
                val real = lf
                val src = lf.source!!
                val u = open(peer, "/upload/$token/${lf.id}", "PUT", timeout = 8000, readTimeout = 60000)
                out.conn = u
                u.doOutput = true
                u.setFixedLengthStreamingMode(lf.size)
                u.setRequestProperty("Content-Type", "application/octet-stream")
                val input = ctx.contentResolver.openInputStream(src) ?: throw IOException("Kan ${lf.name} niet lezen")
                input.use { ins ->
                    u.outputStream.use { os ->
                        val buf = ByteArray(128 * 1024)
                        while (true) {
                            if (out.cancelled) throw IOException("Geannuleerd")
                            val n = ins.read(buf)
                            if (n < 0) break
                            os.write(buf, 0, n)
                            real.done += n
                            live.done += n
                            meter.add(n)
                            publish()
                        }
                    }
                }
                if (u.responseCode != 200) throw IOException("De ontvanger heeft het bestand geweigerd")
                u.disconnect()
            }
            finish(live, Status.DONE)
            Notifier.sent(live.snapshot())
        } catch (e: Exception) {
            if (out.cancelled) finish(live, Status.CANCELLED, "Geannuleerd") else finish(live, Status.ERROR, friendly(e))
        } finally {
            outgoing.remove(live.id)
            if (!hasActiveTransfers()) releaseTransferLocks()
        }
    }

    fun cancel(id: String) {
        val out = outgoing[id]
        if (out != null) {
            out.cancelled = true
            runCatching { out.conn?.disconnect() }
            val key = out.token ?: id
            scope.launch { runCatching { open(out.peer, "/cancel/$key", "POST", timeout = 2500).also { it.doOutput = true; it.setFixedLengthStreamingMode(0); it.outputStream.close(); it.responseCode; it.disconnect() } } }
            synchronized(lives) { lives[id] }?.let { finish(it, Status.CANCELLED, "Geannuleerd") }
            return
        }
        // inkomend
        sessions.values.firstOrNull { it.live.id == id }?.let { it.cancelled = true; return }
        pending[id]?.complete(Decision(false))
    }
}
