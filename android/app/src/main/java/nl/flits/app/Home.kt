package nl.flits.app

import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.InsertDriveFile
import androidx.compose.material.icons.rounded.Notes
import androidx.compose.material.icons.rounded.PhoneAndroid
import androidx.compose.material.icons.rounded.PhotoLibrary
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import java.util.Locale

// ---------- hulpjes ----------
private fun fmtSize(bytes: Double): String {
    if (bytes < 1024) return "${bytes.toLong()} B"
    val units = arrayOf("KB", "MB", "GB", "TB")
    var v = bytes; var i = -1
    do { v /= 1024; i++ } while (v >= 1024 && i < units.size - 1)
    return (if (v >= 100) String.format(Locale.getDefault(), "%.0f", v) else String.format(Locale.getDefault(), "%.1f", v)) + " " + units[i]
}

private fun fmtSize(bytes: Long) = fmtSize(bytes.toDouble())

private fun fmtEta(sec: Double): String = when {
    sec.isNaN() || sec.isInfinite() || sec < 0 -> ""
    sec < 60 -> "${Math.ceil(sec).toInt()} s"
    sec < 3600 -> "${Math.ceil(sec / 60).toInt()} min"
    else -> "${(sec / 3600).toInt()} u ${Math.ceil((sec % 3600) / 60).toInt()} min"
}

private fun fmtAgo(ts: Long): String {
    val s = (System.currentTimeMillis() - ts) / 1000
    return when {
        s < 60 -> "zojuist"
        s < 3600 -> "${s / 60} min geleden"
        s < 86400 -> "${s / 3600} u geleden"
        else -> DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(ts))
    }
}

private fun nFiles(n: Int) = if (n == 1) "1 bestand" else "$n bestanden"

// ---------- hoofdscherm ----------
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(shared: MutableStateFlow<Shared?>) {
    val ctx = LocalContext.current
    val peers by Engine.peers.collectAsState()
    val transfers by Engine.transfers.collectAsState()
    val offers by Engine.offers.collectAsState()
    val settings by Engine.settings.collectAsState()
    val ips by Engine.ips.collectAsState()
    val running by Engine.running.collectAsState()
    val sharedNow by shared.collectAsState()

    val snack = remember { SnackbarHostState() }
    var textTarget by remember { mutableStateOf<Peer?>(null) }
    var showAdd by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var pickTarget by remember { mutableStateOf<Peer?>(null) }

    val update by Updater.state.collectAsState()
    LaunchedEffect(Unit) { Updater.check(ctx) }
    LaunchedEffect(Unit) { Engine.messages.collect { snack.showSnackbar(it) } }

    fun report(err: String?) { if (err != null) Toast.makeText(ctx, err, Toast.LENGTH_LONG).show() }

    val docs = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val p = pickTarget
        if (p != null && uris.isNotEmpty()) report(Engine.sendFiles(p.id, uris))
    }
    val media = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        val p = pickTarget
        if (p != null && uris.isNotEmpty()) report(Engine.sendFiles(p.id, uris))
    }

    fun sendShared(p: Peer) {
        val s = sharedNow ?: return
        report(if (s.text != null) Engine.sendText(p.id, s.text) else Engine.sendFiles(p.id, s.uris))
        shared.value = null
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snack, modifier = Modifier.navigationBarsPadding()) },
    ) { pad ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(pad).statusBarsPadding(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 18.dp, end = 18.dp, top = 6.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { TopBar(onSettings = { showSettings = true }) }
            item { Hero(settings.deviceName, ips.firstOrNull(), running) }

            if (update is Updater.State.Available || update is Updater.State.Downloading || update is Updater.State.Ready ||
                (update as? Updater.State.Failed)?.info != null) item { UpdateBanner() }

            if (sharedNow != null) item {
                val s = sharedNow!!
                ShareBanner(if (s.text != null) "Tekst delen" else nFiles(s.uris.size) + " delen") { shared.value = null }
            }

            item {
                Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    SectionTitle("Apparaten in de buurt", Modifier.weight(1f))
                    TextButton(onClick = { showAdd = true }) {
                        Icon(Icons.Rounded.Add, null, Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)); Text("IP-adres")
                    }
                }
            }

            if (peers.isEmpty()) item { EmptyDevices() }
            else items(peers, key = { it.id }) { p ->
                DeviceCard(
                    peer = p, sharing = sharedNow != null,
                    onShareHere = { sendShared(p) },
                    onFiles = { pickTarget = p; docs.launch(arrayOf("*/*")) },
                    onMedia = { pickTarget = p; media.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
                    onText = { textTarget = p },
                )
            }

            item {
                Row(Modifier.fillMaxWidth().padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    SectionTitle("Activiteit", Modifier.weight(1f))
                    TextButton(onClick = { openDownloads(ctx) }) { Text("Downloads") }
                    if (transfers.any { !it.isLive }) TextButton(onClick = { Engine.clearHistory() }) { Text("Wissen") }
                }
            }
            if (transfers.isEmpty()) item { Quiet("Nog niets verstuurd of ontvangen.\nKies een apparaat hierboven om te beginnen.") }
            else items(transfers, key = { it.id }) { t -> TransferRow(t) }
        }
    }

    textTarget?.let { p -> TextDialog(p, onDismiss = { textTarget = null }, onSend = { txt -> report(Engine.sendText(p.id, txt)); textTarget = null }) }
    if (showAdd) AddDialog(onDismiss = { showAdd = false })
    if (showSettings) SettingsDialog(settings, onDismiss = { showSettings = false })
    offers.firstOrNull()?.let { OfferDialog(it) }
}

// ---------- onderdelen ----------
@Composable
private fun TopBar(onSettings: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(52.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(32.dp).clip(RoundedCornerShape(10.dp)).background(FlitsColors.Gradient), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Bolt, null, tint = Color.White, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(10.dp))
        Text("Flits", fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        IconButton(onClick = onSettings) { Icon(Icons.Rounded.Settings, "Instellingen", tint = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), modifier = modifier, fontSize = 12.sp, letterSpacing = 1.1.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun Hero(name: String, ip: String?, running: Boolean) {
    val pulse = rememberInfiniteTransition(label = "pulse")
    val a by pulse.animateFloat(0.25f, 1f, infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "a")
    Surface(
        shape = RoundedCornerShape(22.dp), color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Row(
            Modifier.background(Brush2()).padding(horizontal = 20.dp, vertical = 18.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(12.dp).clip(CircleShape).background((if (running) FlitsColors.Good else FlitsColors.Bad).copy(alpha = if (running) a else 1f)))
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text("Zichtbaar als", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(name.ifEmpty { "…" }, fontSize = 20.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(ip ?: "Geen wifi", fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun Brush2() = androidx.compose.ui.graphics.Brush.linearGradient(listOf(FlitsColors.Accent.copy(alpha = 0.16f), FlitsColors.Accent2.copy(alpha = 0.06f)))

@Composable
private fun ShareBanner(label: String, onCancel: () -> Unit) {
    Surface(shape = RoundedCornerShape(16.dp), color = FlitsColors.Accent2.copy(alpha = 0.14f), border = BorderStroke(1.dp, FlitsColors.Accent2.copy(alpha = 0.5f))) {
        Row(Modifier.padding(start = 16.dp, top = 8.dp, bottom = 8.dp, end = 6.dp).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(label, fontWeight = FontWeight.SemiBold)
                Text("Kies hieronder het apparaat waar het naartoe moet.", fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = onCancel) { Icon(Icons.Rounded.Close, "Annuleren") }
        }
    }
}

@Composable
private fun EmptyDevices() {
    val t = rememberInfiniteTransition(label = "radar")
    val p by t.animateFloat(0f, 1f, infiniteRepeatable(tween(2600)), label = "p")
    Surface(shape = RoundedCornerShape(22.dp), color = Color.Transparent, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
        Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Canvas(Modifier.size(90.dp)) {
                val c = Offset(size.width / 2, size.height / 2)
                for (k in 0..2) {
                    val q = (p + k / 3f) % 1f
                    drawCircle(FlitsColors.Accent2.copy(alpha = (1f - q) * 0.8f), radius = size.minDimension / 2 * (0.2f + 0.8f * q), center = c, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3f))
                }
                drawCircle(FlitsColors.Accent2, radius = 9f, center = c)
            }
            Spacer(Modifier.height(14.dp))
            Text("Zoeken naar apparaten…", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Spacer(Modifier.height(6.dp))
            Text(
                "Open Flits op je pc. Beide apparaten moeten op hetzelfde wifi-netwerk zitten. Lukt het niet, voeg de pc toe met het IP-adres.",
                fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

@Composable
private fun DeviceCard(peer: Peer, sharing: Boolean, onShareHere: () -> Unit, onFiles: () -> Unit, onMedia: () -> Unit, onText: () -> Unit) {
    Surface(shape = RoundedCornerShape(22.dp), color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
        Column(Modifier.padding(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(46.dp).clip(RoundedCornerShape(14.dp)).background(FlitsColors.Gradient), contentAlignment = Alignment.Center) {
                    Icon(if (peer.isPhone) Icons.Rounded.PhoneAndroid else Icons.Rounded.Computer, null, tint = Color.White, modifier = Modifier.size(24.dp))
                }
                Spacer(Modifier.width(12.dp))
                Column {
                    Text(peer.name, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text((if (peer.isPhone) "Telefoon" else "Computer") + " · " + peer.ip, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Spacer(Modifier.height(14.dp))
            if (sharing) {
                GradientButton("Hierheen sturen", onShareHere, Modifier.fillMaxWidth())
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GradientButton("Bestanden", onFiles, Modifier.weight(1.2f), Icons.Rounded.InsertDriveFile)
                    SoftButton("Foto's", onMedia, Modifier.weight(1f), Icons.Rounded.PhotoLibrary)
                    SoftButton("Tekst", onText, Modifier.weight(1f), Icons.Rounded.Notes)
                }
            }
        }
    }
}

@Composable
private fun GradientButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    Box(
        modifier.height(44.dp).clip(RoundedCornerShape(14.dp)).background(FlitsColors.ButtonGradient).clickableNoRipple(onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) { Icon(icon, null, tint = Color.White, modifier = Modifier.size(17.dp)); Spacer(Modifier.width(6.dp)) }
            Text(label, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, maxLines = 1)
        }
    }
}

@Composable
private fun SoftButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    Box(
        modifier.height(44.dp).clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surfaceVariant).clickableNoRipple(onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) { Icon(icon, null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(17.dp)); Spacer(Modifier.width(6.dp)) }
            Text(label, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, maxLines = 1)
        }
    }
}

private fun Modifier.clickableNoRipple(onClick: () -> Unit): Modifier = this.then(Modifier.clickable(onClick = onClick))

@Composable
private fun Quiet(text: String) {
    Surface(shape = RoundedCornerShape(18.dp), color = Color.Transparent, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
        Text(text, Modifier.fillMaxWidth().padding(22.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center, fontSize = 13.sp)
    }
}

@Composable
private fun TransferRow(t: Transfer) {
    val ctx = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val bad = t.status == Status.ERROR || t.status == Status.DECLINED || t.status == Status.CANCELLED
    val title = if (t.isText) (if (t.incoming) "Tekst van " else "Tekst naar ") + t.peerName
    else (if (t.files.size == 1) t.files[0].name else nFiles(t.files.size)) + (if (t.incoming) " van " else " naar ") + t.peerName

    val sub = when (t.status) {
        Status.WAITING -> if (t.incoming) "Wacht op jouw antwoord" else "Wachten tot ${t.peerName} accepteert…"
        Status.ACTIVE -> {
            val left = if (t.speed > 0) (t.total - t.done) / t.speed else Double.NaN
            "${fmtSize(t.done)} van ${fmtSize(t.total)}" + (if (t.speed > 0) " · ${fmtSize(t.speed)}/s" else "") + (if (left.isNaN()) "" else " · nog ${fmtEta(left)}")
        }
        Status.DONE -> (if (t.isText) "Tekst" else fmtSize(t.total)) + " · " + (if (t.incoming) "ontvangen " else "verstuurd ") + fmtAgo(t.finishedAt)
        Status.DECLINED -> if (t.incoming) "Geweigerd" else "${t.peerName} heeft geweigerd"
        Status.CANCELLED -> "Geannuleerd"
        Status.ERROR -> t.error ?: "Mislukt"
    }

    Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
                    val (icon, tint) = when {
                        bad -> Icons.Rounded.ErrorOutline to FlitsColors.Bad
                        t.isText -> Icons.Rounded.Notes to FlitsColors.Accent2
                        t.incoming -> Icons.Rounded.ArrowDownward to FlitsColors.Good
                        else -> Icons.Rounded.ArrowUpward to FlitsColors.Accent2
                    }
                    Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(sub, fontSize = 12.5.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, color = if (bad) FlitsColors.Bad else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (t.isLive) TextButton(onClick = { Engine.cancel(t.id) }) { Text("Stop") }
            }
            if (t.isLive) {
                Spacer(Modifier.height(10.dp))
                if (t.status == Status.WAITING || t.total == 0L) LinearProgressIndicator(Modifier.fillMaxWidth().height(6.dp).clip(CircleShape), color = FlitsColors.Accent, trackColor = MaterialTheme.colorScheme.surfaceVariant)
                else LinearProgressIndicator(progress = { (t.done.toFloat() / t.total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().height(6.dp).clip(CircleShape), color = FlitsColors.Accent2, trackColor = MaterialTheme.colorScheme.surfaceVariant)
            }
            if (t.isText && t.status == Status.DONE) {
                Spacer(Modifier.height(10.dp))
                SelectionContainer {
                    Text(t.text ?: "", Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceVariant).padding(10.dp), fontSize = 13.sp, maxLines = 6, overflow = TextOverflow.Ellipsis)
                }
                if (t.incoming) Row {
                    TextButton(onClick = { clipboard.setText(AnnotatedString(t.text ?: "")); Toast.makeText(ctx, "Gekopieerd", Toast.LENGTH_SHORT).show() }) { Text("Kopiëren") }
                    if ((t.text ?: "").trim().let { it.startsWith("http://") || it.startsWith("https://") }) {
                        TextButton(onClick = { runCatching { ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(t.text!!.trim())).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) } }) { Text("Link openen") }
                    }
                }
            }
            if (t.incoming && t.status == Status.DONE && t.savedUris.isNotEmpty()) Row {
                TextButton(onClick = { if (!openUri(ctx, t.savedUris[0])) Toast.makeText(ctx, "Geen app gevonden om dit te openen", Toast.LENGTH_SHORT).show() }) { Text("Openen") }
                TextButton(onClick = { openDownloads(ctx) }) { Text("Downloads") }
            }
        }
    }
}

// ---------- dialogen ----------
@Composable
private fun TextDialog(peer: Peer, onDismiss: () -> Unit, onSend: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val clipboard = LocalClipboardManager.current
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = RoundedCornerShape(24.dp),
        title = { Text("Tekst naar ${peer.name}") },
        text = {
            Column {
                OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth().height(140.dp), placeholder = { Text("Typ of plak een tekst of link") })
                TextButton(onClick = { clipboard.getText()?.text?.let { text = it } }) { Text("Klembord plakken") }
            }
        },
        confirmButton = { TextButton(onClick = { onSend(text) }, enabled = text.isNotBlank()) { Text("Versturen") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Annuleren") } },
    )
}

@Composable
private fun AddDialog(onDismiss: () -> Unit) {
    var host by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = RoundedCornerShape(24.dp),
        title = { Text("Apparaat toevoegen") },
        text = {
            Column {
                Text("Open Flits op de pc: bovenin staat het IP-adres van die pc. Typ dat hier in.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(host, { host = it; error = null }, singleLine = true, placeholder = { Text("192.168.1.23") }, isError = error != null, supportingText = { error?.let { Text(it) } })
            }
        },
        confirmButton = {
            TextButton(enabled = host.isNotBlank() && !busy, onClick = {
                busy = true
                scope.launch(kotlinx.coroutines.Dispatchers.IO) {
                    val err = Engine.addManual(host)
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { busy = false; if (err == null) onDismiss() else error = err }
                }
            }) { if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Toevoegen") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Annuleren") } },
    )
}

@Composable
private fun SettingsDialog(s: Engine.Settings, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(s.deviceName) }
    fun close() { Engine.setDeviceName(name); onDismiss() }
    AlertDialog(
        onDismissRequest = { close() },
        shape = RoundedCornerShape(24.dp),
        title = { Text("Instellingen") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(name, { name = it.take(40) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Naam van deze telefoon") })
                SettingSwitch("Op de achtergrond ontvangen", "Flits blijft actief met een melding, zodat je altijd bestanden kunt ontvangen.", s.background) { Engine.setBackground(it) }
                SettingSwitch("Alles automatisch accepteren", "Minder veilig: iedereen op je netwerk kan dan bestanden sturen.", s.autoAcceptAll) { Engine.setAutoAccept(it) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Vertrouwde apparaten", fontWeight = FontWeight.Medium)
                        Text(if (s.trustedCount > 0) "${s.trustedCount} apparaat(en) mogen zonder vragen sturen." else "Nog geen. Kies bij een verzoek “Altijd toestaan”.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (s.trustedCount > 0) OutlinedButton(onClick = { Engine.forgetTrusted() }) { Text("Vergeet") }
                }
                UpdateSettingsRow()
                Text("Ontvangen bestanden staan in Downloads/Flits.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = { TextButton(onClick = { close() }) { Text("Klaar") } },
    )
}

@Composable
private fun SettingSwitch(title: String, help: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title, fontWeight = FontWeight.Medium)
            Text(help, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked, onChange)
    }
}

@Composable
private fun OfferDialog(o: Transfer) {
    var always by remember(o.id) { mutableStateOf(false) }
    val isText = o.files.isEmpty()
    AlertDialog(
        onDismissRequest = { /* alleen via knoppen */ },
        shape = RoundedCornerShape(24.dp),
        title = { Text("${o.peerName} wil iets sturen") },
        text = {
            Column {
                Text(if (isText) "Een stukje tekst" else nFiles(o.files.size) + " · " + fmtSize(o.total), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(10.dp))
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant).padding(12.dp)) {
                    if (isText) Text((o.text ?: "").take(400), fontSize = 13.sp, maxLines = 8, overflow = TextOverflow.Ellipsis)
                    else {
                        o.files.take(6).forEach { f ->
                            Row {
                                Text(f.name, Modifier.weight(1f), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Spacer(Modifier.width(8.dp))
                                Text(fmtSize(f.size), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        if (o.files.size > 6) Text("… en ${o.files.size - 6} meer", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(always, { always = it })
                    Text("Altijd toestaan van dit apparaat", fontSize = 13.sp)
                }
            }
        },
        confirmButton = {
            Button(onClick = { Engine.respondOffer(o.id, true, always) }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary)) { Text("Accepteren") }
        },
        dismissButton = { TextButton(onClick = { Engine.respondOffer(o.id, false, false) }) { Text("Weigeren") } },
    )
}
