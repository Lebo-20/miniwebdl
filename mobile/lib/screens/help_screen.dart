import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:flutter_spinkit/flutter_spinkit.dart';
import '../providers/auth_provider.dart';
import '../services/api_service.dart';
import '../models/admin_models.dart';

class HelpScreen extends StatefulWidget {
  const HelpScreen({Key? key}) : super(key: key);

  @override
  State<HelpScreen> createState() => _HelpScreenState();
}

class _HelpScreenState extends State<HelpScreen> {
  final ApiService _api = ApiService();
  final TextEditingController _messageController = TextEditingController();
  final ScrollController _scrollController = ScrollController();
  
  List<TicketMessage> _messages = [];
  bool _isLoading = true;
  bool _isSending = false;

  @override
  void initState() {
    super.initState();
    _fetchMessages();
  }

  Future<void> _fetchMessages() async {
    final auth = Provider.of<AuthProvider>(context, listen: false);
    if (!auth.isAuthenticated) return;
    
    try {
      final rawMsgs = await _api.getTicketMessages(auth.user!.userId);
      setState(() {
        _messages = rawMsgs.map((m) => TicketMessage.fromJson(m)).toList();
        _isLoading = false;
      });
      _scrollToBottom();
    } catch (e) {
      setState(() {
        _isLoading = false;
      });
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _sendMessage() async {
    final text = _messageController.text.trim();
    if (text.isEmpty) return;

    final auth = Provider.of<AuthProvider>(context, listen: false);
    if (!auth.isAuthenticated) return;

    setState(() {
      _isSending = true;
    });

    _messageController.clear();

    try {
      // Send message to api
      await _api.sendTicketMessage(
        userId: auth.user!.userId,
        userName: auth.user!.displayName,
        message: text,
      );
      
      // Refresh message list
      await _fetchMessages();
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Gagal mengirim pesan: $e'), backgroundColor: Colors.redAccent),
      );
    } finally {
      setState(() {
        _isSending = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF071424),
      appBar: AppBar(
        title: const Text('Live Chat Bantuan', style: TextStyle(fontWeight: FontWeight.bold, color: Colors.white)),
        backgroundColor: const Color(0xFF071424),
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Colors.white),
            onPressed: _fetchMessages,
          ),
        ],
      ),
      body: Column(
        children: [
          // 1. Live Chat messages feed
          Expanded(
            child: _isLoading
                ? const Center(child: SpinKitRing(color: Color(0xFFFFD700), size: 36, lineWidth: 2.5))
                : _messages.isEmpty
                    ? _buildWelcomeMessage()
                    : ListView.builder(
                        controller: _scrollController,
                        padding: const EdgeInsets.all(16),
                        itemCount: _messages.length,
                        itemBuilder: (context, index) {
                          final msg = _messages[index];
                          return _buildChatBubble(msg);
                        },
                      ),
          ),

          // 2. Chat Input Bar
          _buildInputBar(),
        ],
      ),
    );
  }

  Widget _buildWelcomeMessage() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.forum_outlined, size: 64, color: Colors.white10),
            const SizedBox(height: 16),
            const Text(
              'Selamat datang di Pusat Bantuan TEAMDL!',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
            ),
            const SizedBox(height: 8),
            const Text(
              'Silakan ketik kendala Anda (misal: "VIP belum masuk", "video buffering", atau "video error") untuk mendapatkan bantuan instan dari AI dan Admin.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Colors.white54, fontSize: 13),
            ),
            const SizedBox(height: 24),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              alignment: WrapAlignment.center,
              children: [
                _buildQuickReplyBtn('VIP Belum Aktif'),
                _buildQuickReplyBtn('Video Buffering'),
                _buildQuickReplyBtn('Video Error'),
              ],
            )
          ],
        ),
      ),
    );
  }

  Widget _buildQuickReplyBtn(String label) {
    return ActionChip(
      label: Text(label, style: const TextStyle(color: Color(0xFF071424), fontWeight: FontWeight.bold, fontSize: 12)),
      backgroundColor: const Color(0xFFFFD700),
      onPressed: () {
        _messageController.text = label;
        _sendMessage();
      },
    );
  }

  Widget _buildChatBubble(TicketMessage msg) {
    final bool isUser = msg.sender == 'user';
    final bool isSystem = msg.sender == 'system';
    
    if (isSystem) {
      return Container(
        margin: const EdgeInsets.symmetric(vertical: 8),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        decoration: BoxDecoration(
          color: Colors.black26,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          msg.text,
          textAlign: TextAlign.center,
          style: const TextStyle(color: Colors.white38, fontSize: 11, fontStyle: FontStyle.italic),
        ),
      );
    }

    final alignment = isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start;
    final bubbleColor = isUser ? const Color(0xFFFFD700) : const Color(0xFF102846);
    final textColor = isUser ? const Color(0xFF071424) : Colors.white;
    final senderLabel = msg.sender == 'ai' ? 'Asisten AI' : (msg.sender == 'admin' ? 'Admin' : msg.userName);

    return Column(
      crossAxisAlignment: alignment,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 8.0, right: 8.0, bottom: 4),
          child: Text(
            senderLabel,
            style: const TextStyle(color: Colors.white38, fontSize: 11),
          ),
        ),
        Container(
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.75),
          padding: const EdgeInsets.all(12),
          margin: const EdgeInsets.only(bottom: 12),
          decoration: BoxDecoration(
            color: bubbleColor,
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(12),
              topRight: const Radius.circular(12),
              bottomLeft: isUser ? const Radius.circular(12) : const Radius.circular(0),
              bottomRight: isUser ? const Radius.circular(0) : const Radius.circular(12),
            ),
          ),
          child: Text(
            msg.text,
            style: TextStyle(color: textColor, fontSize: 14),
          ),
        ),
      ],
    );
  }

  Widget _buildInputBar() {
    return Container(
      padding: const EdgeInsets.all(12),
      color: const Color(0xFF102846),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _messageController,
              style: const TextStyle(color: Colors.white),
              decoration: const InputDecoration(
                hintText: 'Tulis pesan...',
                hintStyle: TextStyle(color: Colors.white38),
                border: InputBorder.none,
              ),
              onSubmitted: (_) => _sendMessage(),
            ),
          ),
          _isSending
              ? const SpinKitRing(color: Color(0xFFFFD700), size: 24, lineWidth: 2)
              : IconButton(
                  icon: const Icon(Icons.send, color: Color(0xFFFFD700)),
                  onPressed: _sendMessage,
                ),
        ],
      ),
    );
  }
}
