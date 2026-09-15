package cz.paja.eet.ui.screens

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import cz.paja.eet.domain.QrCodeGenerator
import cz.paja.eet.ui.PaymentCategory
import cz.paja.eet.ui.theme.MoneyAmount
import cz.paja.eet.ui.theme.SectionLabel
import cz.paja.eet.ui.TransferQrData
import cz.paja.eet.ui.PaymentOrderCard
import cz.paja.eet.ui.PaymentOrderState
import java.io.File
import java.io.FileOutputStream

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TransferQrScreen(
    data: TransferQrData,
    orderState: PaymentOrderState,
    onBack: () -> Unit,
    onNewPayment: () -> Unit,
) {
    val context = LocalContext.current
    var bitmap by remember(data) { mutableStateOf<Bitmap?>(null) }

    LaunchedEffect(data) {
        bitmap = QrCodeGenerator.generate(data.spdPayload)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Platba převodem") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Zpět")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Card {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(
                            if (data.category == PaymentCategory.SERVICES) "MASÁŽ" else "POUKÁZKY",
                            style = SectionLabel,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text("${data.amountCzk} Kč", style = MoneyAmount)
                    }

                    // The QR sits on its own white surface in both themes. On a dark
                    // card the quiet zone and the darker modules lose each other, and
                    // the customer's banking app cannot read it — a payment screen
                    // that only works in light mode is not a payment screen.
                    val currentBitmap = bitmap
                    if (currentBitmap != null) {
                        Surface(
                            shape = MaterialTheme.shapes.medium,
                            color = Color.White,
                            modifier = Modifier.padding(4.dp),
                        ) {
                            Image(
                                bitmap = currentBitmap.asImageBitmap(),
                                contentDescription = "QR platba",
                                modifier = Modifier
                                    .padding(12.dp)
                                    .size(260.dp),
                            )
                        }
                    }

                    // The symbols are deliberately not spelled out here: both of
                    // them are inside the code above, and the operator reads them
                    // off the payment if they are ever needed. Only the address is
                    // worth showing, because a typo in it is invisible otherwise.
                    if (data.customerEmail.isNotBlank()) {
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        PaymentDetail("E-mail zákazníka", data.customerEmail)
                    }
                }
            }

            // The QR above is what the customer pays with and it is always here —
            // the order is only about what happens *after* the money arrives, so a
            // failure is a warning to act on, never a reason to withhold the QR.
            PaymentOrderCard(orderState)

            Button(
                onClick = { bitmap?.let { shareQrImage(context, it) } },
                enabled = bitmap != null,
                contentPadding = PaddingValues(vertical = 14.dp),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Sdílet QR kód") }

            OutlinedButton(
                onClick = {
                    onNewPayment()
                    onBack()
                },
                contentPadding = PaddingValues(vertical = 14.dp),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Zavřít") }
        }
    }
}

/**
 * A label and its value, label small and quiet, value legible. Used for the
 * customer's address, where a typo is invisible until the receipt fails to
 * arrive.
 */
@Composable
private fun PaymentDetail(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(label, style = SectionLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
    }
}

private fun shareQrImage(context: Context, bitmap: Bitmap) {
    val cacheDir = File(context.cacheDir, "qr_codes").apply { mkdirs() }
    val file = File(cacheDir, "qr-platba.png")
    FileOutputStream(file).use { out -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, out) }

    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(intent, "Sdílet QR kód"))
}
