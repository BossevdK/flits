package nl.flits.app

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

object FlitsColors {
    val Accent = Color(0xFF7C5CFF)
    val Accent2 = Color(0xFF22D3EE)
    val Good = Color(0xFF34D399)
    val Bad = Color(0xFFF87171)
    val Gradient = Brush.linearGradient(listOf(Accent, Accent2))
    val ButtonGradient = Brush.linearGradient(listOf(Accent, Color(0xFF5B8CFF)))
}

private val Dark = darkColorScheme(
    primary = FlitsColors.Accent, onPrimary = Color.White,
    secondary = FlitsColors.Accent2, onSecondary = Color(0xFF00232B),
    background = Color(0xFF0E1016), onBackground = Color(0xFFEEF0F8),
    surface = Color(0xFF1A1E2C), onSurface = Color(0xFFEEF0F8),
    surfaceVariant = Color(0xFF232842), onSurfaceVariant = Color(0xFF8B93AD),
    outline = Color(0xFF262B3D), error = FlitsColors.Bad,
)

private val Light = lightColorScheme(
    primary = Color(0xFF6A47F0), onPrimary = Color.White,
    secondary = Color(0xFF0891B2), onSecondary = Color.White,
    background = Color(0xFFF5F6FB), onBackground = Color(0xFF14172A),
    surface = Color.White, onSurface = Color(0xFF14172A),
    surfaceVariant = Color(0xFFE9ECF7), onSurfaceVariant = Color(0xFF5B6280),
    outline = Color(0xFFD8DCEB), error = Color(0xFFDC2626),
)

@Composable
fun FlitsTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) Dark else Light,
        shapes = Shapes(
            small = RoundedCornerShape(10.dp), medium = RoundedCornerShape(16.dp),
            large = RoundedCornerShape(22.dp), extraLarge = RoundedCornerShape(28.dp),
        ),
        content = content,
    )
}
