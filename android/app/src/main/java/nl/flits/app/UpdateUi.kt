package nl.flits.app

import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Balk bovenin het hoofdscherm als er een nieuwe versie is. */
@Composable
fun UpdateBanner() {
    val ctx = LocalContext.current
    val s by Updater.state.collectAsState()
    val info = when (val st = s) {
        is Updater.State.Available -> st.info
        is Updater.State.Downloading -> st.info
        is Updater.State.Ready -> st.info
        is Updater.State.Failed -> st.info
        else -> null
    } ?: return

    Surface(shape = RoundedCornerShape(18.dp), color = FlitsColors.Good.copy(alpha = 0.12f), border = BorderStroke(1.dp, FlitsColors.Good.copy(alpha = 0.5f))) {
        Column(Modifier.padding(16.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Nieuwe versie ${info.version} beschikbaar", fontWeight = FontWeight.SemiBold)
            when (val st = s) {
                is Updater.State.Available -> {
                    if (info.notes.isNotBlank()) Text(info.notes.take(200), fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = { Updater.download(ctx) }) { Text("Nu bijwerken") }
                }
                is Updater.State.Downloading -> {
                    Text("Downloaden… ${(st.progress * 100).toInt()}%", fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    LinearProgressIndicator(progress = { st.progress }, modifier = Modifier.fillMaxWidth().height(6.dp).clip(CircleShape), color = FlitsColors.Good, trackColor = MaterialTheme.colorScheme.surfaceVariant)
                }
                is Updater.State.Ready -> {
                    Text("Klaar om te installeren. Staat de installatie niet open, geef dan eerst toestemming en tik opnieuw.", fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = { if (!Updater.install(ctx)) Toast.makeText(ctx, "Zet \"Toestaan\" aan en tik daarna opnieuw op Installeren", Toast.LENGTH_LONG).show() }) { Text("Installeren") }
                }
                is Updater.State.Failed -> {
                    Text(st.message, fontSize = 12.5.sp, color = FlitsColors.Bad)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { Updater.download(ctx) }) { Text("Opnieuw proberen") }
                    }
                }
                else -> {}
            }
        }
    }
}

/** Regel in de instellingen: huidige versie en handmatig controleren. */
@Composable
fun UpdateSettingsRow() {
    val ctx = LocalContext.current
    val s by Updater.state.collectAsState()
    val text = when (val st = s) {
        is Updater.State.Checking -> "Controleren…"
        is Updater.State.UpToDate -> "Je hebt de nieuwste versie."
        is Updater.State.Available, is Updater.State.Downloading, is Updater.State.Ready -> "Er is een nieuwe versie, zie het hoofdscherm."
        is Updater.State.Failed -> if (st.info == null) st.message else "Bijwerken mislukt."
        else -> "Flits werkt zichzelf bij vanaf GitHub."
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text("Versie ${Updater.currentVersion(ctx)}", fontWeight = FontWeight.Medium)
            Text(text, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        OutlinedButton(onClick = { Updater.check(ctx, manual = true) }, enabled = s !is Updater.State.Checking) { Text("Controleer") }
    }
}
