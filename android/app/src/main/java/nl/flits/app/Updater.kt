package nl.flits.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Werkt Flits bij vanaf GitHub: zoekt de nieuwste release, downloadt Flits.apk en opent de installatie van Android. */
object Updater {
    const val REPO = "BossevdK/flits"
    private const val CHECK_EVERY_MS = 6L * 3600 * 1000

    data class Info(val version: String, val notes: String, val url: String, val size: Long, val sha256: String?)

    sealed interface State {
        data object Idle : State
        data object Checking : State
        data object UpToDate : State
        data class Available(val info: Info) : State
        data class Downloading(val info: Info, val progress: Float) : State
        data class Ready(val info: Info, val file: File) : State
        data class Failed(val message: String, val info: Info? = null) : State
    }

    val state = MutableStateFlow<State>(State.Idle)

    private fun versionParts(v: String) = v.trim().removePrefix("v").removePrefix("V").split(".", "-", "+").mapNotNull { it.toIntOrNull() }

    fun isNewer(remote: String, local: String): Boolean {
        val a = versionParts(remote); val b = versionParts(local)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }; val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    fun currentVersion(ctx: Context): String =
        runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "0"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("flits", Context.MODE_PRIVATE)

    /** Automatisch hooguit eens per 6 uur; handmatig altijd. */
    fun check(ctx: Context, manual: Boolean = false) {
        val app = ctx.applicationContext
        val busy = state.value
        if (busy is State.Checking || busy is State.Downloading) return
        if (!manual && System.currentTimeMillis() - prefs(app).getLong("updateChecked", 0) < CHECK_EVERY_MS) return
        if (!manual && (busy is State.Available || busy is State.Ready)) return
        state.value = State.Checking
        Engine.scope.launch {
            try {
                val info = fetchLatest(currentVersion(app))
                prefs(app).edit().putLong("updateChecked", System.currentTimeMillis()).apply()
                state.value = if (info == null) State.UpToDate else State.Available(info)
            } catch (e: Exception) {
                state.value = if (manual) State.Failed("Controleren mislukt: ${e.message ?: "geen verbinding"}") else State.Idle
            }
        }
    }

    private fun fetchLatest(current: String): Info? {
        val c = URL("https://api.github.com/repos/$REPO/releases/latest").openConnection() as HttpURLConnection
        c.connectTimeout = 10000; c.readTimeout = 15000
        c.setRequestProperty("Accept", "application/vnd.github+json")
        c.setRequestProperty("User-Agent", "Flits")
        try {
            if (c.responseCode == 404) return null
            if (c.responseCode != 200) throw IOException("GitHub antwoordde met ${c.responseCode}")
            val o = JSONObject(c.inputStream.readBytes().toString(Charsets.UTF_8))
            val tag = o.optString("tag_name")
            if (tag.isEmpty() || !isNewer(tag, current)) return null
            val assets = o.optJSONArray("assets") ?: return null
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                if (a.optString("name").endsWith(".apk", ignoreCase = true)) {
                    val digest = a.optString("digest").removePrefix("sha256:").takeIf { it.length == 64 }
                    return Info(tag.removePrefix("v"), o.optString("body").trim(), a.getString("browser_download_url"), a.optLong("size"), digest)
                }
            }
            return null
        } finally { c.disconnect() }
    }

    fun download(ctx: Context) {
        val info = when (val s = state.value) {
            is State.Available -> s.info
            is State.Failed -> s.info ?: return
            else -> return
        }
        val app = ctx.applicationContext
        state.value = State.Downloading(info, 0f)
        Engine.scope.launch {
            try {
                val uri = Uri.parse(info.url)
                if (uri.scheme != "https" || uri.host != "github.com") throw IOException("Onverwachte downloadlink")
                val dir = File(app.cacheDir, "updates").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() }
                val file = File(dir, "Flits-${info.version}.apk")
                val c = URL(info.url).openConnection() as HttpURLConnection
                c.connectTimeout = 10000; c.readTimeout = 30000
                c.setRequestProperty("User-Agent", "Flits")
                try {
                    if (c.responseCode != 200) throw IOException("Downloaden mislukt (${c.responseCode})")
                    val host = c.url.host
                    if (!(host == "github.com" || host.endsWith(".githubusercontent.com"))) throw IOException("Onverwachte downloadserver")
                    val total = c.contentLengthLong.takeIf { it > 0 } ?: info.size
                    val md = MessageDigest.getInstance("SHA-256")
                    var done = 0L
                    var last = 0L
                    c.inputStream.use { input ->
                        file.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n); md.update(buf, 0, n); done += n
                                val now = System.currentTimeMillis()
                                if (total > 0 && now - last > 150) { last = now; state.value = State.Downloading(info, (done.toFloat() / total).coerceIn(0f, 1f)) }
                            }
                        }
                    }
                    if (info.size > 0 && done != info.size) { file.delete(); throw IOException("Download is niet compleet") }
                    val hash = md.digest().joinToString("") { "%02x".format(it) }
                    if (info.sha256 != null && !hash.equals(info.sha256, ignoreCase = true)) { file.delete(); throw IOException("Controlesom klopt niet, download is beschadigd") }
                } finally { c.disconnect() }
                state.value = State.Ready(info, file)
                install(app)
            } catch (e: Exception) {
                state.value = State.Failed(e.message ?: "Downloaden mislukt", info)
            }
        }
    }

    /**
     * Opent het installatiescherm van Android. Eerst moet je eenmalig "Onbekende apps installeren" toestaan voor Flits;
     * daarna tik je nog een keer op Installeren. Android controleert zelf dat de update met dezelfde sleutel is ondertekend.
     */
    fun install(ctx: Context): Boolean {
        val ready = state.value as? State.Ready ?: return false
        if (!ctx.packageManager.canRequestPackageInstalls()) {
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return false
        }
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", ready.file)
        ctx.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        return true
    }
}
