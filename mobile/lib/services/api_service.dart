import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';
import 'secure_storage_service.dart';
import '../utils/security_utils.dart';

class ApiService {
  final Dio _dio = Dio();
  final SecureStorageService _storage = SecureStorageService();
  
  // Default Base URL for the production website backend
  static const String defaultBaseUrl = 'https://teamdlbot.biz.id';
  String _baseUrl = defaultBaseUrl;

  ApiService() {
    _dio.options.connectTimeout = const Duration(seconds: 15);
    _dio.options.receiveTimeout = const Duration(seconds: 15);
    
    // Add custom security header interceptor
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        options.baseUrl = _baseUrl;
        
        // Retrieve device and session keys
        final device = await _storage.getDeviceIdentifiers();
        var deviceId = device['deviceId'];
        var fingerprint = device['fingerprint'];
        
        // If not initialized, create them
        if (deviceId == null || fingerprint == null) {
          deviceId = SecurityUtils.generateDeviceId();
          fingerprint = await SecurityUtils.generateFingerprint();
          await _storage.saveDeviceIdentifiers(deviceId, fingerprint);
        }

        final session = await _storage.getSession();
        final sessionId = session['sessionId'];
        final csrf = session['csrf'];
        final userId = session['userId'];

        // Add device headers to all requests
        options.headers['X-Device-Id'] = deviceId;
        options.headers['X-Device-Fingerprint'] = fingerprint;
        options.headers['User-Agent'] = 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
        
        if (userId != null) {
          options.headers['X-User-Id'] = userId;
        }

        // Handle Cookie Session ID
        if (sessionId != null) {
          options.headers['Cookie'] = 'mw_session=$sessionId';
        }

        // Check if the request requires signature (usually all except login and static config)
        final path = options.path;
        final needsSignature = csrf != null && 
                               !path.contains('/api/auth/login-code') &&
                               !path.contains('/api/security/session') &&
                               !path.contains('/api/firebase-config');

        if (needsSignature) {
          final timestamp = DateTime.now().millisecondsSinceEpoch;
          final nonce = const Uuid().v4();
          
          // Generate HMAC signature
          // Note: options.path contains the relative endpoint path like /api/user/profile
          final signature = await SecurityUtils.generateRequestSignature(
            method: options.method,
            path: path,
            timestamp: timestamp,
            nonce: nonce,
            deviceId: deviceId,
            fingerprint: fingerprint,
            csrfKey: csrf,
          );

          options.headers['X-Request-Timestamp'] = timestamp.toString();
          options.headers['X-Request-Nonce'] = nonce;
          options.headers['X-Request-Signature'] = signature;
        }

        return handler.next(options);
      },
      onError: (DioException e, handler) {
        // Log API failures for diagnostics
        print('API Error [${e.response?.statusCode}]: ${e.message}');
        return handler.next(e);
      }
    ));
  }

  // Update base URL (e.g. for developer debug environments or domain changes)
  void setBaseUrl(String url) {
    _baseUrl = url.endsWith('/') ? url.substring(0, url.length - 1) : url;
  }

  String get baseUrl => _baseUrl;

  // 1. Verify Telegram 6-Digit Login Code
  Future<Map<String, dynamic>> loginWithCode(String code) async {
    try {
      final response = await _dio.post('/api/auth/login-code', data: {'code': code});
      return response.data;
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Gagal memverifikasi kode login.');
    }
  }

  // 2. Establish Session
  Future<Map<String, dynamic>> startSession(String userId) async {
    try {
      final device = await _storage.getDeviceIdentifiers();
      final response = await _dio.post(
        '/api/security/session',
        data: {
          'deviceId': device['deviceId'],
          'fingerprint': device['fingerprint'],
          'userId': userId
        }
      );
      return response.data;
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Gagal membuat sesi keamanan.');
    }
  }

  // 3. Get User Profile Detail
  Future<Map<String, dynamic>> getUserProfile(String userId) async {
    try {
      final response = await _dio.get('/api/user/profile', queryParameters: {'userId': userId});
      return response.data;
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Gagal memuat profil pengguna.');
    }
  }

  // 4. Fetch Platforms Configuration
  Future<List<dynamic>> getPlatforms() async {
    try {
      final response = await _dio.get('/api/platforms');
      return response.data;
    } on DioException catch (e) {
      throw Exception('Gagal memuat daftar platform: ${e.message}');
    }
  }

  // 5. Fetch Platform Sources Detail (Incremental Catalog Load)
  Future<List<dynamic>> getPlatformCatalog(String path) async {
    try {
      final response = await _dio.get(path);
      return response.data;
    } on DioException catch (e) {
      throw Exception('Gagal memuat katalog platform: ${e.message}');
    }
  }

  // 6. Request Secure Playback Stream URL
  Future<String> getStreamUrl(String launchKey, String episodeId) async {
    try {
      final response = await _dio.post(
        '/api/stream/token',
        data: {'launchKey': launchKey, 'episodeId': episodeId}
      );
      
      final streamUrl = response.data['data']?['streamUrl'] ?? '';
      if (streamUrl.isEmpty) {
        throw Exception('Stream URL kosong');
      }
      return streamUrl;
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Gagal memuat link video.');
    }
  }

  // 7. Close Session
  Future<void> logout() async {
    try {
      await _dio.post('/api/security/logout');
    } catch (_) {
      // Allow local logout even if server fails
    }
  }

  // 8. Fetch Firebase dynamic config
  Future<Map<String, dynamic>> getFirebaseConfig() async {
    try {
      final response = await _dio.get('/api/firebase-config');
      return response.data;
    } catch (e) {
      throw Exception('Gagal memuat konfigurasi Firebase: $e');
    }
  }

  // 9. Log Playback Error on Server for Live Stream Monitor
  Future<void> logStreamError({
    required String dramaTitle,
    required String episodeName,
    required String errorType,
    required String cdn,
    required String userId,
  }) async {
    try {
      await _dio.post('/api/security/log-stream-error', data: {
        'dramaTitle': dramaTitle,
        'episodeName': episodeName,
        'errorType': errorType,
        'cdn': cdn,
        'userId': userId
      });
    } catch (_) {}
  }

  // ==========================================
  // HELP & LIVE CHAT TICKETS ENDPOINTS
  // ==========================================

  Future<Map<String, dynamic>> sendTicketMessage({
    required String userId,
    required String userName,
    String? message,
    String? imageBase64,
  }) async {
    try {
      final response = await _dio.post('/api/tickets/send', data: {
        'userId': userId,
        'userName': userName,
        if (message != null) 'message': message,
        if (imageBase64 != null) 'image': imageBase64,
      });
      return response.data;
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Gagal mengirim pesan bantuan.');
    }
  }

  Future<List<dynamic>> getTicketMessages(String userId) async {
    try {
      final response = await _dio.get('/api/tickets/messages', queryParameters: {'userId': userId});
      return response.data;
    } catch (e) {
      return [];
    }
  }

  // ==========================================
  // ADMIN PANEL ENDPOINTS
  // ==========================================

  Future<Map<String, dynamic>> getAdminVipStats() async {
    try {
      final response = await _dio.get('/api/admin/vip');
      return response.data;
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Akses admin ditolak.');
    }
  }

  Future<List<dynamic>> getAdminBotUsers() async {
    try {
      final response = await _dio.get('/api/admin/bot-users');
      return response.data;
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Gagal memuat bot users.');
    }
  }

  Future<void> performAdminUserAction(String userId, String action, {String reason = ''}) async {
    try {
      await _dio.post('/api/admin/bot-users/action', data: {
        'userId': userId,
        'action': action, // 'ban', 'unban', 'kick', 'active'
        'reason': reason
      });
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Gagal melakukan aksi admin.');
    }
  }

  Future<void> modifyUserVip(String userId, int planDays, String action) async {
    try {
      await _dio.post('/api/admin/vip/modify', data: {
        'userId': userId,
        'planDays': planDays,
        'action': action, // 'add' or 'remove'
        'paymentSource': 'admin-mobile'
      });
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Gagal mengubah status VIP.');
    }
  }

  Future<List<dynamic>> getAdminPayments() async {
    try {
      final response = await _dio.get('/api/admin/payments');
      return response.data;
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Gagal memuat transaksi.');
    }
  }

  Future<void> sendAdminBroadcast({
    required String title,
    required String message,
    String? imageUrl,
  }) async {
    try {
      await _dio.post('/api/admin/broadcast', data: {
        'title': title,
        'message': message,
        if (imageUrl != null) 'imageUrl': imageUrl
      });
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Gagal mengirim siaran.');
    }
  }

  Future<List<dynamic>> getAdminStreamLogs() async {
    try {
      final response = await _dio.get('/api/admin/security/stream-logs');
      return response.data;
    } on DioException catch (e) {
      throw Exception(e.response?.data['error'] ?? 'Gagal memuat log streaming.');
    }
  }

  Future<void> clearAdminStreamLogs() async {
    try {
      await _dio.post('/api/admin/security/stream-logs/clear');
    } catch (_) {}
  }
}
