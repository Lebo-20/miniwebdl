import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SecureStorageService {
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  static const String _keySessionId = 'mw_session_id';
  static const String _keyCsrf = 'mw_csrf_token';
  static const String _keyUserId = 'mw_user_id';
  static const String _keyTelegramId = 'mw_telegram_id';
  static const String _keyUsername = 'mw_username';
  static const String _keyFirstName = 'mw_first_name';
  static const String _keyLastName = 'mw_last_name';
  static const String _keyRole = 'mw_role';
  static const String _keyDeviceId = 'mw_device_id';
  static const String _keyFingerprint = 'mw_fingerprint';

  // Save session details
  Future<void> saveSession({
    required String sessionId,
    required String csrf,
    required String userId,
    required String telegramId,
    required String username,
    required String firstName,
    required String lastName,
    required String role,
  }) async {
    await _storage.write(key: _keySessionId, value: sessionId);
    await _storage.write(key: _keyCsrf, value: csrf);
    await _storage.write(key: _keyUserId, value: userId);
    await _storage.write(key: _keyTelegramId, value: telegramId);
    await _storage.write(key: _keyUsername, value: username);
    await _storage.write(key: _keyFirstName, value: firstName);
    await _storage.write(key: _keyLastName, value: lastName);
    await _storage.write(key: _keyRole, value: role);
  }

  // Get session details
  Future<Map<String, String?>> getSession() async {
    return {
      'sessionId': await _storage.read(key: _keySessionId),
      'csrf': await _storage.read(key: _keyCsrf),
      'userId': await _storage.read(key: _keyUserId),
      'telegramId': await _storage.read(key: _keyTelegramId),
      'username': await _storage.read(key: _keyUsername),
      'firstName': await _storage.read(key: _keyFirstName),
      'lastName': await _storage.read(key: _keyLastName),
      'role': await _storage.read(key: _keyRole),
    };
  }

  // Save device identifiers
  Future<void> saveDeviceIdentifiers(String deviceId, String fingerprint) async {
    await _storage.write(key: _keyDeviceId, value: deviceId);
    await _storage.write(key: _keyFingerprint, value: fingerprint);
  }

  // Get device identifiers
  Future<Map<String, String?>> getDeviceIdentifiers() async {
    return {
      'deviceId': await _storage.read(key: _keyDeviceId),
      'fingerprint': await _storage.read(key: _keyFingerprint),
    };
  }

  // Clear all session details on logout
  Future<void> clearSession() async {
    await _storage.delete(key: _keySessionId);
    await _storage.delete(key: _keyCsrf);
    await _storage.delete(key: _keyUserId);
    await _storage.delete(key: _keyTelegramId);
    await _storage.delete(key: _keyUsername);
    await _storage.delete(key: _keyFirstName);
    await _storage.delete(key: _keyLastName);
    await _storage.delete(key: _keyRole);
  }
}
