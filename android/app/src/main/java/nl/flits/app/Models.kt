package nl.flits.app

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

enum class Status { WAITING, ACTIVE, DONE, ERROR, DECLINED, CANCELLED }

data class Peer(
    val id: String,
    val name: String,
    val type: String,
    val ip: String,
    val port: Int,
    val lastSeen: Long = System.currentTimeMillis(),
) {
    val isPhone get() = type == "android" || type == "ios"
}

data class FileItem(val id: Int, val name: String, val size: Long, val done: Long)

/** Onveranderlijke momentopname voor de UI. */
data class Transfer(
    val id: String,
    val incoming: Boolean,
    val peerId: String,
    val peerName: String,
    val peerType: String,
    val status: Status,
    val files: List<FileItem>,
    val text: String?,
    val done: Long,
    val total: Long,
    val speed: Double,
    val error: String?,
    val savedUris: List<String>,
    val startedAt: Long,
    val finishedAt: Long,
) {
    val isLive get() = status == Status.WAITING || status == Status.ACTIVE
    val isText get() = text != null && files.isEmpty()

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("incoming", incoming); put("peerId", peerId); put("peerName", peerName); put("peerType", peerType)
        put("status", status.name); put("text", text ?: JSONObject.NULL); put("total", total); put("error", error ?: JSONObject.NULL)
        put("startedAt", startedAt); put("finishedAt", finishedAt)
        put("files", JSONArray().also { a -> files.forEach { f -> a.put(JSONObject().put("id", f.id).put("name", f.name).put("size", f.size)) } })
        put("savedUris", JSONArray(savedUris))
    }

    companion object {
        fun fromJson(o: JSONObject): Transfer {
            val files = o.optJSONArray("files")?.let { a ->
                (0 until a.length()).map { i -> a.getJSONObject(i).let { FileItem(it.getInt("id"), it.getString("name"), it.getLong("size"), it.getLong("size")) } }
            } ?: emptyList()
            val uris = o.optJSONArray("savedUris")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            return Transfer(
                id = o.getString("id"), incoming = o.getBoolean("incoming"), peerId = o.getString("peerId"),
                peerName = o.getString("peerName"), peerType = o.optString("peerType", "other"),
                status = runCatching { Status.valueOf(o.getString("status")) }.getOrDefault(Status.DONE),
                files = files, text = if (o.isNull("text")) null else o.getString("text"),
                done = o.optLong("total"), total = o.optLong("total"), speed = 0.0,
                error = if (o.isNull("error")) null else o.getString("error"),
                savedUris = uris, startedAt = o.optLong("startedAt"), finishedAt = o.optLong("finishedAt"),
            )
        }
    }
}

class LiveFile(val id: Int, val name: String, val size: Long, val source: android.net.Uri? = null) {
    @Volatile var done = 0L
}

/** Veranderlijke staat van een lopende overdracht (alleen voor de engine). */
class Live(
    val id: String,
    val incoming: Boolean,
    val peerId: String,
    val peerName: String,
    val peerType: String,
    val files: List<LiveFile>,
    val text: String?,
) {
    val total = files.sumOf { it.size }
    @Volatile var status = Status.WAITING
    @Volatile var done = 0L
    @Volatile var speed = 0.0
    @Volatile var error: String? = null
    @Volatile var finishedAt = 0L
    @Volatile var remoteOfferId: String? = null
    val savedUris = CopyOnWriteArrayList<String>()
    val startedAt = System.currentTimeMillis()

    fun snapshot() = Transfer(
        id, incoming, peerId, peerName, peerType, status,
        files.map { FileItem(it.id, it.name, it.size, it.done) }, text, done, total, speed, error,
        savedUris.toList(), startedAt, finishedAt,
    )
}

/** Meet de snelheid over ~0,5 s. */
class Meter(private val live: Live) {
    private var lastT = System.currentTimeMillis()
    private var bytes = 0L
    fun add(n: Int) {
        bytes += n
        val now = System.currentTimeMillis()
        if (now - lastT >= 500) {
            live.speed = bytes * 1000.0 / (now - lastT)
            lastT = now; bytes = 0
        }
    }
}
