import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'providers/auth_provider.dart';
import 'providers/theme_provider.dart';
import 'providers/playback_provider.dart';
import 'providers/download_provider.dart';
import 'screens/splash_screen.dart';
import 'screens/login_screen.dart';
import 'screens/home_screen.dart';
import 'screens/drama_detail_screen.dart';
import 'player/video_player_screen.dart';
import 'screens/settings_screen.dart';
import 'downloads/download_screen.dart';
import 'screens/help_screen.dart';
import 'admin/admin_dashboard.dart';
import 'services/fcm_service.dart';
import 'services/api_service.dart';
import 'package:firebase_core/firebase_core.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  
  try {
    final api = ApiService();
    final config = await api.getFirebaseConfig();
    
    await Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: config['apiKey'] ?? '',
        appId: config['appId'] ?? '',
        messagingSenderId: config['messagingSenderId'] ?? '',
        projectId: config['projectId'] ?? '',
        authDomain: config['authDomain'],
        storageBucket: config['storageBucket'],
        measurementId: config['measurementId'],
      ),
    );
    print("Firebase default app initialized at startup.");
  } catch (e) {
    print("Failed to initialize Firebase at startup: $e. Running offline/no-fcm mode.");
  }
  
  runApp(const MyApp());
}


class MyApp extends StatefulWidget {
  const MyApp({Key? key}) : super(key: key);

  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  // Global Navigator Key to support Deep Linking from Firebase notifications
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();
  late FcmService _fcmService;

  @override
  void initState() {
    super.initState();
    _fcmService = FcmService(navigatorKey: _navigatorKey);
    
    // Initialize push notifications in background
    _fcmService.initialize();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        ChangeNotifierProvider(create: (_) => AuthProvider()),
        ChangeNotifierProvider(create: (_) => PlaybackProvider()),
        ChangeNotifierProvider(create: (_) => DownloadProvider()),
      ],
      child: Consumer<ThemeProvider>(
        builder: (context, theme, child) {
          return MaterialApp(
            title: 'TEAMDL',
            debugShowCheckedModeBanner: false,
            navigatorKey: _navigatorKey,
            themeMode: theme.themeMode,
            
            // 1. Dark Theme Configuration
            darkTheme: ThemeData(
              brightness: Brightness.dark,
              primaryColor: const Color(0xFFFFD700),
              scaffoldBackgroundColor: const Color(0xFF071424),
              appBarTheme: const AppBarTheme(
                backgroundColor: Color(0xFF071424),
                iconTheme: IconThemeData(color: Colors.white),
                elevation: 0,
              ),
              colorScheme: const ColorScheme.dark(
                primary: Color(0xFFFFD700),
                secondary: Color(0xFFFFA500),
                surface: Color(0xFF102846),
              ),
            ),

            // 2. Light Theme Configuration (fallback option)
            theme: ThemeData(
              brightness: Brightness.light,
              primaryColor: const Color(0xFFFFD700),
              scaffoldBackgroundColor: const Color(0xFFF0F4F8),
              appBarTheme: const AppBarTheme(
                backgroundColor: Color(0xFFF0F4F8),
                iconTheme: IconThemeData(color: Colors.black),
                elevation: 0,
              ),
              colorScheme: const ColorScheme.light(
                primary: Color(0xFFFFD700),
                secondary: Color(0xFFFFA500),
                surface: Colors.white,
              ),
            ),
            
            initialRoute: '/',
            onGenerateRoute: (settings) {
              switch (settings.name) {
                case '/':
                  return MaterialPageRoute(builder: (_) => const SplashScreen());
                case '/login':
                  return MaterialPageRoute(builder: (_) => const LoginScreen());
                case '/home':
                  return MaterialPageRoute(builder: (_) => const HomeScreen());
                case '/detail':
                  final dramaId = settings.arguments as String;
                  return MaterialPageRoute(
                    builder: (_) => DramaDetailScreen(dramaId: dramaId),
                  );
                case '/watch':
                  final args = settings.arguments as Map<String, dynamic>;
                  return MaterialPageRoute(
                    builder: (_) => VideoPlayerScreen(
                      dramaId: args['dramaId'] as String,
                      episodeId: args['episodeId'] as String,
                    ),
                  );
                case '/settings':
                  return MaterialPageRoute(builder: (_) => const SettingsScreen());
                case '/downloads':
                  return MaterialPageRoute(builder: (_) => const DownloadScreen());
                case '/help':
                  return MaterialPageRoute(builder: (_) => const HelpScreen());
                case '/admin':
                  return MaterialPageRoute(builder: (_) => const AdminDashboard());
                default:
                  return MaterialPageRoute(builder: (_) => const SplashScreen());
              }
            },
          );
        },
      ),
    );
  }
}
