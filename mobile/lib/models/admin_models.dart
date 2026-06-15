class TicketModel {
  final String ticketCode;
  final String userId;
  final String userName;
  final String telegramId;
  final String telegramUsername;
  final String topic;
  final DateTime createdAt;
  final String status;
  final String mode;

  TicketModel({
    required this.ticketCode,
    required this.userId,
    required this.userName,
    required this.telegramId,
    required this.telegramUsername,
    required this.topic,
    required this.createdAt,
    required this.status,
    required this.mode,
  });

  factory TicketModel.fromJson(Map<String, dynamic> json) {
    return TicketModel(
      ticketCode: json['ticketCode'] ?? '',
      userId: json['userId'] ?? '',
      userName: json['userName'] ?? '',
      telegramId: json['telegramId'] ?? '',
      telegramUsername: json['telegramUsername'] ?? '',
      topic: json['topic'] ?? '',
      createdAt: DateTime.fromMillisecondsSinceEpoch(json['createdAt'] ?? DateTime.now().millisecondsSinceEpoch),
      status: json['status'] ?? 'open',
      mode: json['mode'] ?? 'manual',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'ticketCode': ticketCode,
      'userId': userId,
      'userName': userName,
      'telegramId': telegramId,
      'telegramUsername': telegramUsername,
      'topic': topic,
      'createdAt': createdAt.millisecondsSinceEpoch,
      'status': status,
      'mode': mode,
    };
  }
}

class TicketMessage {
  final String id;
  final String sender; // 'user', 'admin', 'system', 'ai'
  final String userName;
  final String text;
  final DateTime timestamp;
  final bool autoTicketOpened;

  TicketMessage({
    required this.id,
    required this.sender,
    required this.userName,
    required this.text,
    required this.timestamp,
    this.autoTicketOpened = false,
  });

  factory TicketMessage.fromJson(Map<String, dynamic> json) {
    return TicketMessage(
      id: json['id'] ?? '',
      sender: json['sender'] ?? 'system',
      userName: json['userName'] ?? '',
      text: json['text'] ?? '',
      timestamp: DateTime.fromMillisecondsSinceEpoch(json['timestamp'] ?? DateTime.now().millisecondsSinceEpoch),
      autoTicketOpened: json['autoTicketOpened'] ?? false,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'sender': sender,
      'userName': userName,
      'text': text,
      'timestamp': timestamp.millisecondsSinceEpoch,
      'autoTicketOpened': autoTicketOpened,
    };
  }
}

class PaymentModel {
  final String id;
  final String userId;
  final String userName;
  final String telegramId;
  final String telegramUsername;
  final String plan;
  final int planDays;
  final String method;
  final String status;
  final String source;
  final int total;
  final String proofUrl;
  final String proofFile;
  final DateTime date;
  final DateTime updatedAt;

  PaymentModel({
    required this.id,
    required this.userId,
    required this.userName,
    required this.telegramId,
    required this.telegramUsername,
    required this.plan,
    required this.planDays,
    required this.method,
    required this.status,
    required this.source,
    required this.total,
    required this.proofUrl,
    required this.proofFile,
    required this.date,
    required this.updatedAt,
  });

  factory PaymentModel.fromJson(Map<String, dynamic> json) {
    return PaymentModel(
      id: json['id'] ?? '',
      userId: json['userId'] ?? '',
      userName: json['userName'] ?? '',
      telegramId: json['telegramId'] ?? '',
      telegramUsername: json['telegramUsername'] ?? '',
      plan: json['plan'] ?? '',
      planDays: json['planDays'] is int ? json['planDays'] : int.tryParse(json['planDays']?.toString() ?? '0') ?? 0,
      method: json['method'] ?? '',
      status: json['status'] ?? 'pending',
      source: json['source'] ?? 'Telegram Bot',
      total: json['total'] is int ? json['total'] : int.tryParse(json['total']?.toString() ?? '0') ?? 0,
      proofUrl: json['proofUrl'] ?? '',
      proofFile: json['proofFile'] ?? '',
      date: DateTime.tryParse(json['date'] ?? '') ?? DateTime.now(),
      updatedAt: DateTime.tryParse(json['updatedAt'] ?? '') ?? DateTime.now(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'userId': userId,
      'userName': userName,
      'telegramId': telegramId,
      'telegramUsername': telegramUsername,
      'plan': plan,
      'planDays': planDays,
      'method': method,
      'status': status,
      'source': source,
      'total': total,
      'proofUrl': proofUrl,
      'proofFile': proofFile,
      'date': date.toIso8601String(),
      'updatedAt': updatedAt.toIso8601String(),
    };
  }
}
