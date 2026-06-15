import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:uuid/uuid.dart';

class SecurityUtils {
  static const Uuid _uuid = Uuid();

  // Generate unique Device ID
  static String generateDeviceId() {
    return _uuid.v4();
  }

  // Generate device fingerprint based on device information
  static Future<String> generateFingerprint() async {
    final deviceInfo = DeviceInfoPlugin();
    String rawData = '';

    try {
      final androidInfo = await deviceInfo.androidInfo;
      rawData = '${androidInfo.model}|${androidInfo.brand}|${androidInfo.hardware}|${androidInfo.display}';
    } catch (_) {
      try {
        final iosInfo = await deviceInfo.iosInfo;
        rawData = '${iosInfo.name}|${iosInfo.model}|${iosInfo.systemName}|${iosInfo.systemVersion}';
      } catch (_) {
        rawData = 'unknown-device-${DateTime.now().millisecondsSinceEpoch}';
      }
    }

    return sha256Hash(rawData);
  }

  // Calculate SHA-256 Hash
  static String sha256Hash(String input) {
    final bytes = utf8.encode(input);
    final digest = sha256.convert(bytes);
    return digest.toString();
  }

  // Calculate HMAC-SHA256 signature for API Requests
  static String calculateHmac(String message, String key) {
    final keyBytes = utf8.encode(key);
    final messageBytes = utf8.encode(message);
    final hmac = Hmac(sha256, keyBytes);
    final digest = hmac.convert(messageBytes);
    return digest.toString();
  }

  // Helper to generate the signature string
  // Format: method:path:timestamp:nonce:deviceHash
  static Future<String> generateRequestSignature({
    required String method,
    required String path,
    required int timestamp,
    required String nonce,
    required String deviceId,
    required String fingerprint,
    required String csrfKey,
  }) async {
    final devHash = sha256Hash('$deviceId:$fingerprint');
    final message = '${method.toUpperCase()}:$path:$timestamp:$nonce:$devHash';
    return calculateHmac(message, csrfKey);
  }
}
