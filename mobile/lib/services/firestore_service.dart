import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';
import 'api_service.dart';

class FirestoreService {
  final ApiService _api = ApiService();
  bool _initialized = false;
  FirebaseFirestore? _firestore;

  static const String _keyFavorites = 'TEAMDL_favorites';
  static const String _keyHistory = 'TEAMDL_history';

  // Initialize Firebase dynamically using configuration from API
  Future<void> initialize() async {
    if (_initialized) return;

    try {
      // Fetch dynamic firebase config from backend
      final config = await _api.getFirebaseConfig();
      
      // If Firebase is already initialized, just get the firestore instance
      if (Firebase.apps.isNotEmpty) {
        _firestore = FirebaseFirestore.instance;
        _initialized = true;
        return;
      }

      final options = FirebaseOptions(
        apiKey: config['apiKey'] ?? '',
        appId: config['appId'] ?? '',
        messagingSenderId: config['messagingSenderId'] ?? '',
        projectId: config['projectId'] ?? '',
        authDomain: config['authDomain'],
        storageBucket: config['storageBucket'],
        measurementId: config['measurementId'],
      );

      final app = await Firebase.initializeApp(
        name: 'TeamDLMobile',
        options: options,
      );

      _firestore = FirebaseFirestore.instanceFor(app: app);
      _initialized = true;
      print('Firebase dynamically initialized for mobile app.');
    } catch (e) {
      print('Error initializing Firebase: $e. Falling back to offline mode.');
    }
  }

  // Get firestore database instance
  FirebaseFirestore? get db {
    return _firestore;
  }

  // Sync Favorites (realtime merging with Firestore)
  Future<void> syncFavorites(String userId) async {
    await initialize();
    if (_firestore == null) return;

    try {
      final prefs = await SharedPreferences.getInstance();
      
      // Load local favorites
      final localJson = prefs.getString(_keyFavorites) ?? '{}';
      final Map<String, dynamic> localFavs = json.decode(localJson);

      // Load remote favorites
      final favRef = _firestore!.collection('users').doc(userId).collection('favorites');
      final favSnap = await favRef.get();
      final Map<String, Map<String, dynamic>> remoteFavs = {};
      
      for (var doc in favSnap.docs) {
        remoteFavs[doc.id] = doc.data();
      }

      // Merge favorites
      final mergedFavs = <String, Map<String, dynamic>>{};
      
      // Add all remote first
      remoteFavs.forEach((key, value) {
        mergedFavs[key] = Map<String, dynamic>.from(value);
      });

      // Add/overwrite with local if newer
      localFavs.forEach((key, value) {
        final localItem = Map<String, dynamic>.from(value);
        final remoteItem = remoteFavs[key];
        
        if (remoteItem == null) {
          mergedFavs[key] = localItem;
        } else {
          final localTime = DateTime.parse(localItem['updatedAt'] ?? DateTime.now().toIso8601String());
          final remoteTime = DateTime.parse(remoteItem['updatedAt'] ?? DateTime.now().toIso8601String());
          if (localTime.isAfter(remoteTime)) {
            mergedFavs[key] = localItem;
          }
        }
      });

      // Upload newer items back to remote
      for (var entry in mergedFavs.entries) {
        final key = entry.key;
        final mergedVal = entry.value;
        final remoteVal = remoteFavs[key];
        
        if (remoteVal == null || 
            DateTime.parse(mergedVal['updatedAt']).isAfter(DateTime.parse(remoteVal['updatedAt']))) {
          await favRef.doc(key).set(mergedVal);
        }
      }

      // Save merged to local storage
      await prefs.setString(_keyFavorites, json.encode(mergedFavs));
    } catch (e) {
      print('Failed to sync favorites: $e');
    }
  }

  // Sync History (keep only last 7 days)
  Future<void> syncHistory(String userId) async {
    await initialize();
    if (_firestore == null) return;

    try {
      final prefs = await SharedPreferences.getInstance();
      final now = DateTime.now();
      final sevenDaysAgo = now.subtract(const Duration(days: 7));

      // Load local history
      final localJson = prefs.getString(_keyHistory) ?? '{}';
      final Map<String, dynamic> localHist = json.decode(localJson);

      // Filter local older than 7 days
      localHist.removeWhere((key, value) {
        final timeStr = value['updatedAt'];
        if (timeStr == null) return true;
        final time = DateTime.tryParse(timeStr) ?? now;
        return time.isBefore(sevenDaysAgo);
      });

      // Load remote history
      final histRef = _firestore!.collection('users').doc(userId).collection('history');
      final histSnap = await histRef.get();
      final Map<String, Map<String, dynamic>> remoteHist = {};
      
      for (var doc in histSnap.docs) {
        remoteHist[doc.id] = doc.data();
      }

      // Merge history
      final mergedHist = <String, Map<String, dynamic>>{};
      
      remoteHist.forEach((key, value) {
        final timeStr = value['updatedAt'];
        if (timeStr != null) {
          final time = DateTime.tryParse(timeStr) ?? now;
          if (time.isAfter(sevenDaysAgo)) {
            mergedHist[key] = Map<String, dynamic>.from(value);
          }
        }
      });

      localHist.forEach((key, value) {
        final localItem = Map<String, dynamic>.from(value);
        final remoteItem = remoteHist[key];
        
        if (remoteItem == null) {
          mergedHist[key] = localItem;
        } else {
          final localTime = DateTime.parse(localItem['updatedAt'] ?? now.toIso8601String());
          final remoteTime = DateTime.parse(remoteItem['updatedAt'] ?? now.toIso8601String());
          if (localTime.isAfter(remoteTime)) {
            mergedHist[key] = localItem;
          }
        }
      });

      // Upload newer items back to remote
      for (var entry in mergedHist.entries) {
        final key = entry.key;
        final mergedVal = entry.value;
        final remoteVal = remoteHist[key];
        
        if (remoteVal == null || 
            DateTime.parse(mergedVal['updatedAt']).isAfter(DateTime.parse(remoteVal['updatedAt']))) {
          await histRef.doc(key).set(mergedVal);
        }
      }

      // Save merged to local storage
      await prefs.setString(_keyHistory, json.encode(mergedHist));
    } catch (e) {
      print('Failed to sync history: $e');
    }
  }

  // Get local watchlist
  Future<Map<String, dynamic>> getLocalFavorites() async {
    final prefs = await SharedPreferences.getInstance();
    final jsonStr = prefs.getString(_keyFavorites) ?? '{}';
    return json.decode(jsonStr);
  }

  // Get local history
  Future<Map<String, dynamic>> getLocalHistory() async {
    final prefs = await SharedPreferences.getInstance();
    final jsonStr = prefs.getString(_keyHistory) ?? '{}';
    return json.decode(jsonStr);
  }

  // Add item to local favorites & upload to remote
  Future<void> addToFavorites(String userId, String dramaId, Map<String, dynamic> dramaData) async {
    final prefs = await SharedPreferences.getInstance();
    final localJson = prefs.getString(_keyFavorites) ?? '{}';
    final Map<String, dynamic> localFavs = json.decode(localJson);

    final item = {
      ...dramaData,
      'updatedAt': DateTime.now().toIso8601String(),
    };

    localFavs[dramaId] = item;
    await prefs.setString(_keyFavorites, json.encode(localFavs));

    await initialize();
    if (_firestore != null) {
      try {
        await _firestore!.collection('users').doc(userId).collection('favorites').doc(dramaId).set(item);
      } catch (e) {
        print('Error uploading favorite to Firestore: $e');
      }
    }
  }

  // Remove item from favorites
  Future<void> removeFromFavorites(String userId, String dramaId) async {
    final prefs = await SharedPreferences.getInstance();
    final localJson = prefs.getString(_keyFavorites) ?? '{}';
    final Map<String, dynamic> localFavs = json.decode(localJson);

    localFavs.remove(dramaId);
    await prefs.setString(_keyFavorites, json.encode(localFavs));

    await initialize();
    if (_firestore != null) {
      try {
        await _firestore!.collection('users').doc(userId).collection('favorites').doc(dramaId).delete();
      } catch (e) {
        print('Error deleting favorite from Firestore: $e');
      }
    }
  }

  // Add item to history
  Future<void> addToHistory(String userId, String dramaId, Map<String, dynamic> historyData) async {
    final prefs = await SharedPreferences.getInstance();
    final localJson = prefs.getString(_keyHistory) ?? '{}';
    final Map<String, dynamic> localHist = json.decode(localJson);

    final item = {
      ...historyData,
      'updatedAt': DateTime.now().toIso8601String(),
    };

    localHist[dramaId] = item;
    await prefs.setString(_keyHistory, json.encode(localHist));

    await initialize();
    if (_firestore != null) {
      try {
        await _firestore!.collection('users').doc(userId).collection('history').doc(dramaId).set(item);
      } catch (e) {
        print('Error uploading history to Firestore: $e');
      }
    }
  }
}
