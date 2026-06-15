class UserProfile {
  final String userId;
  final String telegramId;
  final String username;
  final String firstName;
  final String lastName;
  final String role;
  final bool isVip;
  final DateTime? vipExpiresAt;
  final String? vipPurchaseDate;

  UserProfile({
    required this.userId,
    required this.telegramId,
    required this.username,
    required this.firstName,
    required this.lastName,
    this.role = 'user',
    this.isVip = false,
    this.vipExpiresAt,
    this.vipPurchaseDate,
  });

  factory UserProfile.fromJson(Map<String, dynamic> json) {
    // Check if membership is in nested structures
    final vipInfo = json['vip'] ?? json['membership'] ?? {};
    final isVipActive = vipInfo['active'] ?? false;
    
    DateTime? expires;
    if (vipInfo['expiresAt'] != null) {
      expires = DateTime.tryParse(vipInfo['expiresAt']);
    } else if (vipInfo['vipUntil'] != null) {
      expires = DateTime.tryParse(vipInfo['vipUntil']);
    }

    return UserProfile(
      userId: json['userId'] ?? json['id']?.toString() ?? '',
      telegramId: json['telegramId'] ?? json['id']?.toString() ?? '',
      username: json['username'] ?? '',
      firstName: json['firstName'] ?? json['first_name'] ?? 'User',
      lastName: json['lastName'] ?? json['last_name'] ?? '',
      role: json['role'] ?? 'user',
      isVip: isVipActive,
      vipExpiresAt: expires,
      vipPurchaseDate: vipInfo['purchaseDate'],
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'userId': userId,
      'telegramId': telegramId,
      'username': username,
      'firstName': firstName,
      'lastName': lastName,
      'role': role,
      'vip': {
        'active': isVip,
        'expiresAt': vipExpiresAt?.toIso8601String(),
        'purchaseDate': vipPurchaseDate,
      }
    };
  }

  String get displayName => '$firstName $lastName'.trim();
  bool get isAdmin => role.toLowerCase() == 'admin';
}
