import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

class FcmService {
  final FirebaseMessaging _fcm = FirebaseMessaging.instance;
  final GlobalKey<NavigatorState> navigatorKey;

  FcmService({required this.navigatorKey});

  // Initialize notifications
  Future<void> initialize() async {
    try {
      // 1. Request permission (iOS & Android 13+)
      NotificationSettings settings = await _fcm.requestPermission(
        alert: true,
        announcement: false,
        badge: true,
        carPlay: false,
        criticalAlert: false,
        provisional: false,
        sound: true,
      );

      print('User granted notification permission: ${settings.authorizationStatus}');

      // 2. Get FCM Device Token
      String? token = await _fcm.getToken();
      print('FCM Registration Token: $token');

      // 3. Handle foreground messages
      FirebaseMessaging.onMessage.listen((RemoteMessage message) {
        print('Got a message whilst in the foreground!');
        print('Message data: ${message.data}');

        if (message.notification != null) {
          print('Message also contained a notification: ${message.notification?.title}');
          // Show in-app banner or toast if active
          _showInAppNotification(message);
        }
      });

      // 4. Handle notification tap when app is in background but opened
      FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
        print('Notification tapped and opened app!');
        _handleDeepLink(message.data);
      });

      // 5. Check if app was opened from terminated state by a notification
      RemoteMessage? initialMessage = await _fcm.getInitialMessage();
      if (initialMessage != null) {
        print('App opened from terminated state via notification');
        _handleDeepLink(initialMessage.data);
      }
    } catch (e) {
      print('Error initializing FCM: $e');
    }
  }

  // Parse payload and route to correct screen
  void _handleDeepLink(Map<String, dynamic> data) {
    final String? dramaId = data['dramaId'] ?? data['id'];
    final String? episodeId = data['episodeId'] ?? data['ep'];
    final String? type = data['type'];

    if (dramaId != null) {
      if (episodeId != null) {
        // Route directly to video player
        navigatorKey.currentState?.pushNamed('/watch', arguments: {
          'dramaId': dramaId,
          'episodeId': episodeId,
        });
      } else {
        // Route to drama detail page
        navigatorKey.currentState?.pushNamed('/detail', arguments: dramaId);
      }
    } else if (type == 'admin_announcement') {
      navigatorKey.currentState?.pushNamed('/profile');
    }
  }

  // Show inline notification UI if app is open
  void _showInAppNotification(RemoteMessage message) {
    final context = navigatorKey.currentContext;
    if (context == null) return;

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              message.notification?.title ?? 'Notifikasi Baru',
              style: const TextStyle(fontWeight: FontWeight.bold, color: Colors.white),
            ),
            Text(
              message.notification?.body ?? '',
              style: const TextStyle(color: Colors.white70),
            ),
          ],
        ),
        action: SnackBarAction(
          label: 'BUKA',
          textColor: const Color(0xFFFFD700), // Gold
          onPressed: () => _handleDeepLink(message.data),
        ),
        backgroundColor: const Color(0xFF102846),
        duration: const Duration(seconds: 5),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    );
  }
}
