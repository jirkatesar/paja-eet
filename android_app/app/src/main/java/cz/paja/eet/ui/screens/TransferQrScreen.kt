package cz.paja.eet.ui.screens

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.foundation.Image
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import cz.paja.eet.domain.QrCodeGenerator
import cz.paja.eet.ui.PaymentCategory
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
    onRetryOrder: () -> Unit,
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
                    modifier = Modifier.padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        "${data.amountCzk} Kč — ${if (data.category == PaymentCategory.SERVICES) "masáž" else "poukázky"}",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Text("KS: ${data.constantSymbol}", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        if (data.category == PaymentCategory.VOUCHERS) "VS (číslo poukázky): ${data.variableSymbol}"
                        else "VS: ${data.variableSymbol}",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (data.customerEmail.isNotBlank()) {
                        Text("E-mail: ${data.customerEmail}", style = MaterialTheme.typography.bodyMedium)
                    }

                    val currentBitmap = bitmap
                    if (currentBitmap != null) {
                        Image(
                            bitmap = currentBitmap.asImageBitmap(),
                            contentDescription = "QR platba",
                            modifier = Modifier.size(280.dp),
                        )
                    }
                }
            }

            // The QR above is what the customer pays with and it is always here —
            // the order is only about what happens *after* the money arrives, so a
            // failure is a warning to act on, never a reason to withhold the QR.
            PaymentOrderCard(orderState, isVoucher = data.category == PaymentCategory.VOUCHERS, onRetryOrder)

            Text(
                "Nechte zákazníka naskenovat QR kód platební bankovní aplikací.",
                style = MaterialTheme.typography.bodyMedium,
            )

            Button(
                onClick = { bitmap?.let { shareQrImage(context, it) } },
                enabled = bitmap != null,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Sdílet QR kód") }

            Button(
                onClick = {
                    onNewPayment()
                    onBack()
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Zavřít") }
        }
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
