import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';
import '../providers/playback_provider.dart';
import '../models/drama_model.dart';

class SearchScreen extends StatefulWidget {
  const SearchScreen({Key? key}) : super(key: key);

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final TextEditingController _searchController = TextEditingController();
  List<String> _searchHistory = [];
  List<DramaModel> _searchResults = [];
  String _selectedGenre = 'Semua';
  String _selectedCountry = 'Semua';
  String _selectedYear = 'Semua';
  bool _isSearching = false;

  static const String _keySearchHistory = 'TEAMDL_search_history';

  @override
  void initState() {
    super.initState();
    _loadSearchHistory();
  }

  Future<void> _loadSearchHistory() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _searchHistory = prefs.getStringList(_keySearchHistory) ?? [];
    });
  }

  Future<void> _saveSearchHistory(String query) async {
    if (query.trim().isEmpty) return;
    final prefs = await SharedPreferences.getInstance();
    
    // Remove if duplicate, add to top, and limit to 10 items
    _searchHistory.remove(query);
    _searchHistory.insert(0, query);
    if (_searchHistory.length > 10) {
      _searchHistory = _searchHistory.sublist(0, 10);
    }
    
    await prefs.setStringList(_keySearchHistory, _searchHistory);
    setState(() {});
  }

  Future<void> _clearSearchHistory() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_keySearchHistory);
    setState(() {
      _searchHistory.clear();
    });
  }

  void _performSearch(String query) {
    if (query.trim().isEmpty) {
      setState(() {
        _searchResults = [];
        _isSearching = false;
      });
      return;
    }

    final playback = Provider.of<PlaybackProvider>(context, listen: false);
    final dramas = playback.dramas;

    final results = dramas.where((drama) {
      final matchesQuery = drama.title.toLowerCase().contains(query.toLowerCase()) ||
          drama.genre.toLowerCase().contains(query.toLowerCase()) ||
          drama.platform.toLowerCase().contains(query.toLowerCase());
          
      final matchesGenre = _selectedGenre == 'Semua' || drama.genre == _selectedGenre;
      final matchesCountry = _selectedCountry == 'Semua' || drama.country == _selectedCountry;
      final matchesYear = _selectedYear == 'Semua' || drama.year == _selectedYear;

      return matchesQuery && matchesGenre && matchesCountry && matchesYear;
    }).toList();

    setState(() {
      _searchResults = results;
      _isSearching = true;
    });
  }

  // Get unique filters from loaded dramas
  List<String> _getUniqueGenres(List<DramaModel> dramas) {
    final genres = dramas.map((d) => d.genre).where((g) => g.isNotEmpty).toSet().toList();
    return ['Semua', ...genres];
  }

  List<String> _getUniqueCountries(List<DramaModel> dramas) {
    final countries = dramas.map((d) => d.country).where((c) => c.isNotEmpty).toSet().toList();
    return ['Semua', ...countries];
  }

  List<String> _getUniqueYears(List<DramaModel> dramas) {
    final years = dramas.map((d) => d.year).where((y) => y.isNotEmpty).toSet().toList();
    years.sort((a, b) => b.compareTo(a)); // Descending order
    return ['Semua', ...years];
  }

  @override
  Widget build(BuildContext context) {
    final playback = Provider.of<PlaybackProvider>(context);
    final dramas = playback.dramas;
    
    final genres = _getUniqueGenres(dramas);
    final countries = _getUniqueCountries(dramas);
    final years = _getUniqueYears(dramas);

    return Scaffold(
      backgroundColor: const Color(0xFF071424),
      appBar: AppBar(
        title: const Text('Cari Drama', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        backgroundColor: const Color(0xFF071424),
        elevation: 0,
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 1. Search Bar
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: TextField(
              controller: _searchController,
              onChanged: _performSearch,
              onSubmitted: (value) {
                _saveSearchHistory(value);
                _performSearch(value);
              },
              style: const TextStyle(color: Colors.white),
              decoration: InputDecoration(
                hintText: 'Cari judul, platform, atau genre...',
                hintStyle: const TextStyle(color: Colors.white38),
                prefixIcon: const Icon(Icons.search, color: Colors.white54),
                suffixIcon: _searchController.text.isNotEmpty
                    ? IconButton(
                        icon: const Icon(Icons.clear, color: Colors.white54),
                        onPressed: () {
                          _searchController.clear();
                          _performSearch('');
                        },
                      )
                    : null,
                filled: true,
                fillColor: const Color(0xFF102846),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
          ),

          // 2. Dropdown Filters
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16.0),
            child: Row(
              children: [
                Expanded(
                  child: _buildFilterDropdown('Genre', _selectedGenre, genres, (val) {
                    setState(() => _selectedGenre = val!);
                    _performSearch(_searchController.text);
                  }),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _buildFilterDropdown('Negara', _selectedCountry, countries, (val) {
                    setState(() => _selectedCountry = val!);
                    _performSearch(_searchController.text);
                  }),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _buildFilterDropdown('Tahun', _selectedYear, years, (val) {
                    setState(() => _selectedYear = val!);
                    _performSearch(_searchController.text);
                  }),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // 3. Search Results or Search History
          Expanded(
            child: _isSearching
                ? _buildSearchResults()
                : _buildSearchHistory(),
          ),
        ],
      ),
    );
  }

  Widget _buildFilterDropdown(
    String label,
    String currentValue,
    List<String> items,
    void Function(String?) onChanged,
  ) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8.0),
      decoration: BoxDecoration(
        color: const Color(0xFF102846),
        borderRadius: BorderRadius.circular(8),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          value: items.contains(currentValue) ? currentValue : 'Semua',
          dropdownColor: const Color(0xFF102846),
          style: const TextStyle(color: Colors.white, fontSize: 12),
          icon: const Icon(Icons.arrow_drop_down, color: Colors.white54),
          onChanged: onChanged,
          items: items.map<DropdownMenuItem<String>>((String value) {
            return DropdownMenuItem<String>(
              value: value,
              child: Text(value, overflow: TextOverflow.ellipsis),
            );
          }).toList(),
        ),
      ),
    );
  }

  Widget _buildSearchResults() {
    if (_searchResults.isEmpty) {
      return const Center(
        child: Text(
          'Tidak ada drama yang cocok dengan filter.',
          style: TextStyle(color: Colors.white38),
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      itemCount: _searchResults.length,
      itemBuilder: (context, index) {
        final drama = _searchResults[index];
        return ListTile(
          onTap: () {
            _saveSearchHistory(_searchController.text);
            Navigator.pushNamed(context, '/detail', arguments: drama.id);
          },
          leading: Container(
            width: 50,
            height: 70,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(4),
              image: DecorationImage(
                image: NetworkImage(drama.poster),
                fit: BoxFit.cover,
              ),
            ),
          ),
          title: Text(drama.title, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
          subtitle: Text('${drama.platform} • ${drama.episodes} Ep • ${drama.genre}', style: const TextStyle(color: Colors.white54)),
          trailing: const Icon(Icons.chevron_right, color: Colors.white24),
        );
      },
    );
  }

  Widget _buildSearchHistory() {
    if (_searchHistory.isEmpty) {
      return const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.search, size: 64, color: Colors.white10),
            SizedBox(height: 12),
            Text(
              'Mulai mencari drama favorit Anda',
              style: TextStyle(color: Colors.white38),
            ),
          ],
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 8.0),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.between,
            children: [
              const Text(
                'RIWAYAT PENCARIAN',
                style: TextStyle(
                  color: Colors.white38,
                  fontSize: 12,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 1.2,
                ),
              ),
              TextButton(
                onPressed: _clearSearchHistory,
                child: const Text('Hapus Semua', style: TextStyle(color: Color(0xFFFFD700), fontSize: 12)),
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView.builder(
            itemCount: _searchHistory.length,
            itemBuilder: (context, index) {
              final query = _searchHistory[index];
              return ListTile(
                leading: const Icon(Icons.history, color: Colors.white30),
                title: Text(query, style: const TextStyle(color: Colors.white70)),
                trailing: IconButton(
                  icon: const Icon(Icons.close, size: 16, color: Colors.white30),
                  onPressed: () async {
                    setState(() {
                      _searchHistory.removeAt(index);
                    });
                    final prefs = await SharedPreferences.getInstance();
                    await prefs.setStringList(_keySearchHistory, _searchHistory);
                  },
                ),
                onTap: () {
                  _searchController.text = query;
                  _performSearch(query);
                },
              );
            },
          ),
        ),
      ],
    );
  }
}
