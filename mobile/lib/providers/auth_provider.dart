import 'package:flutter/material.dart';
import '../models/user_profile.dart';
import '../services/api_service.dart';
import '../services/secure_storage_service.dart';

class AuthProvider extends ChangeNotifier {
  final ApiService _api = ApiService();
  final SecureStorageService _storage = SecureStorageService();

  UserProfile? _user;
  bool _isLoading = false;
  bool _initialized = false;
  String? _errorMessage;

  UserProfile? get user => _user;
  bool get isAuthenticated => _user != null;
  bool get isLoading => _isLoading;
  bool get initialized => _initialized;
  String? get errorMessage => _errorMessage;

  // 1. Try to load existing session (Auto-Login)
  Future<void> tryAutoLogin() async {
    if (_initialized) return;
    _isLoading = true;
    _errorMessage = null;
    notifyListeners();

    try {
      final session = await _storage.getSession();
      final userId = session['userId'];
      final sessionId = session['sessionId'];

      if (userId != null && sessionId != null) {
        // Fetch fresh profile details from API
        final profileData = await _api.getUserProfile(userId);
        if (profileData['ok'] == true && profileData['user'] != null) {
          _user = UserProfile.fromJson(profileData['user']);
        }
      }
    } catch (e) {
      print('Auto login failed: $e. Sesi mungkin kadaluarsa.');
      await _storage.clearSession();
      _user = null;
    } finally {
      _isLoading = false;
      _initialized = true;
      notifyListeners();
    }
  }

  // 2. Login using 6-Digit Telegram code
  Future<bool> loginWithTelegram(String code) async {
    _isLoading = true;
    _errorMessage = null;
    notifyListeners();

    try {
      // 1. Verify code on backend
      final authData = await _api.loginWithCode(code);
      if (authData['ok'] != true || authData['userId'] == null) {
        throw Exception('Kode tidak valid.');
      }

      final String userId = authData['userId'];

      // 2. Issue a secure session on backend
      final sessionData = await _api.startSession(userId);
      if (sessionData['sessionId'] == null || sessionData['csrf'] == null) {
        throw Exception('Gagal membuat sesi masuk.');
      }

      // 3. Construct user details
      final userProfile = UserProfile(
        userId: userId,
        telegramId: authData['telegramId'] ?? '',
        username: authData['username'] ?? '',
        firstName: authData['firstName'] ?? 'User',
        lastName: authData['lastName'] ?? '',
        role: sessionData['role'] ?? 'user', // Backed role in session
        isVip: sessionData['vip']?['active'] ?? false,
        vipExpiresAt: sessionData['vip']?['expiresAt'] != null 
            ? DateTime.tryParse(sessionData['vip']['expiresAt']) 
            : null,
      );

      // 4. Save to secure storage
      await _storage.saveSession(
        sessionId: sessionData['sessionId'],
        csrf: sessionData['csrf'],
        userId: userId,
        telegramId: userProfile.telegramId,
        username: userProfile.username,
        firstName: userProfile.firstName,
        lastName: userProfile.lastName,
        role: userProfile.role,
      );

      _user = userProfile;
      _isLoading = false;
      notifyListeners();
      return true;
    } catch (e) {
      _errorMessage = e.toString().replaceAll('Exception: ', '');
      _isLoading = false;
      notifyListeners();
      return false;
    }
  }

  // Refresh profile details (to get updated VIP/membership details)
  Future<void> refreshProfile() async {
    if (_user == null) return;
    try {
      final profileData = await _api.getUserProfile(_user!.userId);
      if (profileData['ok'] == true && profileData['user'] != null) {
        _user = UserProfile.fromJson(profileData['user']);
        notifyListeners();
      }
    } catch (e) {
      print('Failed to refresh profile: $e');
    }
  }

  // 3. Logout safely
  Future<void> logout() async {
    _isLoading = true;
    notifyListeners();

    try {
      await _api.logout();
    } catch (_) {}

    await _storage.clearSession();
    _user = null;
    _isLoading = false;
    notifyListeners();
  }
}
