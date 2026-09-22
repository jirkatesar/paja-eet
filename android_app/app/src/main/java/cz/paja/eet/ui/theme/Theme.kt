package cz.paja.eet.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The app's colours, type and shapes.
 *
 * The green is the one the vouchers are printed in, so what a customer is handed
 * and what the operator is looking at are recognisably the same thing.
 *
 * Before this, the palette was two hand-picked blues — and on any phone running
 * Android 12 or newer it was replaced wholesale by the wallpaper's, because
 * dynamic colour was on. Every till showed a different app and this green never
 * appeared at all. A shop's own tool should look like the shop, so dynamic
 * colour is gone rather than merely defaulted off.
 */

private val Green = Color(0xFF2F6B4F)
private val GreenLight = Color(0xFF9BD5B1)
private val GreenContainer = Color(0xFFB7F0CE)
private val GreenContainerDark = Color(0xFF14513A)

private val LightColors = lightColorScheme(
    primary = Green,
    onPrimary = Color.White,
    primaryContainer = GreenContainer,
    onPrimaryContainer = Color(0xFF00210F),

    secondary = Color(0xFF4F6354),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFD2E8D6),
    onSecondaryContainer = Color(0xFF0C1F13),

    tertiary = Color(0xFF3A6470),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFBEEAF8),
    onTertiaryContainer = Color(0xFF001F27),

    background = Color(0xFFF7FBF4),
    onBackground = Color(0xFF191D18),
    surface = Color(0xFFF7FBF4),
    onSurface = Color(0xFF191D18),
    surfaceVariant = Color(0xFFDCE5DB),
    onSurfaceVariant = Color(0xFF404943),
    outline = Color(0xFF707972),
    outlineVariant = Color(0xFFC0C9C0),

    error = Color(0xFFBA1A1A),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
)

private val DarkColors = darkColorScheme(
    primary = GreenLight,
    onPrimary = Color(0xFF003921),
    primaryContainer = GreenContainerDark,
    onPrimaryContainer = GreenContainer,

    secondary = Color(0xFFB6CCBA),
    onSecondary = Color(0xFF223527),
    secondaryContainer = Color(0xFF384B3D),
    onSecondaryContainer = Color(0xFFD2E8D6),

    tertiary = Color(0xFFA2CEDC),
    onTertiary = Color(0xFF033541),
    tertiaryContainer = Color(0xFF224C58),
    onTertiaryContainer = Color(0xFFBEEAF8),

    background = Color(0xFF101410),
    onBackground = Color(0xFFE1E4DD),
    surface = Color(0xFF101410),
    onSurface = Color(0xFFE1E4DD),
    surfaceVariant = Color(0xFF404943),
    onSurfaceVariant = Color(0xFFC0C9C0),
    outline = Color(0xFF8A938B),
    outlineVariant = Color(0xFF404943),

    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
)

/**
 * Roomier corners than the Material 3 baseline. Cards and fields are the largest
 * things on these screens, and the baseline's 12dp reads as cramped against a
 * full-width text field.
 */
private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(22.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/**
 * The baseline scale with weight carrying the hierarchy rather than size, which
 * is what stops a dense form reading as a wall of equally loud text.
 */
private val AppTypography = Typography().let { base ->
    base.copy(
        headlineMedium = base.headlineMedium.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp),
        titleLarge = base.titleLarge.copy(fontWeight = FontWeight.SemiBold),
        titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelLarge = base.labelLarge.copy(fontWeight = FontWeight.SemiBold),
    )
}

/** The amount, sized to be read from the customer's side of the counter. */
val MoneyAmount = TextStyle(
    fontSize = 34.sp,
    lineHeight = 40.sp,
    fontWeight = FontWeight.SemiBold,
    letterSpacing = (-0.5).sp,
)

/**
 * A label in the bottom bar.
 *
 * Four of them now share one row, and at the baseline size — `labelMedium`,
 * 12sp with tracking — the longest label broke in the middle of the word on a
 * 360dp-wide phone, which is what the bar looked like on the first device it
 * ran on. Sized to fit instead, with the letter spacing taken out: what that
 * tracking buys in a label standing on its own is not worth a hyphen-less break
 * in a menu. "Neodeslané" is the one to measure against now.
 */
val BarLabel = TextStyle(
    fontSize = 10.sp,
    lineHeight = 12.sp,
    fontWeight = FontWeight.Medium,
    letterSpacing = 0.sp,
)

/** The small heading above a group of controls. */
val SectionLabel = TextStyle(
    fontSize = 12.sp,
    lineHeight = 16.sp,
    fontWeight = FontWeight.SemiBold,
    letterSpacing = 0.8.sp,
    textAlign = TextAlign.Start,
)

@Composable
fun PajaEetTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}
