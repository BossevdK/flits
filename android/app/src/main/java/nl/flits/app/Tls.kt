package nl.flits.app

import android.content.Context
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import java.io.File
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Date
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Zelfondertekend certificaat voor de ontvangstserver. Het verkeer is versleuteld; apparaten
 * vertrouwen elkaar op het lokale netwerk niet via een certificaatketen maar via jouw keuze
 * om een verzoek te accepteren.
 */
object Tls {
    private val PASS = "flits".toCharArray()

    fun load(ctx: Context): Pair<KeyStore, KeyManagerFactory> {
        val file = File(ctx.filesDir, "tls.p12")
        var ks = KeyStore.getInstance("PKCS12")
        val ok = file.exists() && runCatching { file.inputStream().use { ks.load(it, PASS) } }.isSuccess
        if (!ok) {
            ks = KeyStore.getInstance("PKCS12")
            ks.load(null, null)
            create(ks)
            save(ks, file)
        }
        return ks to KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(ks, PASS) }
    }

    private fun save(ks: KeyStore, file: File) {
        file.outputStream().use { ks.store(it, PASS) }
    }

    private fun create(ks: KeyStore) {
        val kp = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val name = X500Name("CN=flits.local")
        val from = Date(System.currentTimeMillis() - 24L * 3600 * 1000)
        val to = Date(System.currentTimeMillis() + 3650L * 24 * 3600 * 1000)
        val holder = JcaX509v3CertificateBuilder(name, BigInteger(64, SecureRandom()), from, to, name, kp.public)
            .build(JcaContentSignerBuilder("SHA256withRSA").build(kp.private))
        val cert = JcaX509CertificateConverter().getCertificate(holder)
        ks.setKeyEntry("flits", kp.private, PASS, arrayOf(cert))
    }

    // Client: accepteert het zelfondertekende certificaat van het andere Flits-apparaat.
    private val trustAll = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = emptyArray()
    }

    val clientFactory: SSLSocketFactory by lazy {
        SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trustAll), SecureRandom()) }.socketFactory
    }
}
