import { formatFileSize, formatDate } from './utils/index.js';

const FileBrowser = {
  currentPage: 1,
  
  async init() {
    await this.loadHeaderStats();
    this.setupEventListeners();
    await this.browseFiles();
  },

  async loadHeaderStats() {
    try {
      const statsRes = await fetch('/api/v1/files/stats');
      const stats = await statsRes.json();

      if (stats.status === 'success') {
        document.getElementById('totalFiles').textContent = 
          stats.data.total.count.toLocaleString();
        document.getElementById('totalSize').textContent = 
          formatFileSize(stats.data.total.totalSize);
        document.getElementById('totalExtensions').textContent = 
          stats.data.byExtension.length;
        
        // Get directory count from the backend
        this.loadDirectoryCount();
        
        // Populate extension filter
        const extFilter = document.getElementById('extensionFilter');
        stats.data.byExtension.forEach(ext => {
          const option = document.createElement('option');
          option.value = ext.extension;
          option.textContent = `${ext.extension} (${ext.count})`;
          extFilter.appendChild(option);
        });
      }
    } catch (error) {
      console.error('Failed to load header stats:', error);
    }
  },

  async loadDirectoryCount() {
    try {
      const response = await fetch('/api/v1/storage/directory-count');
      const data = await response.json();
      
      if (data.status === 'success') {
        document.getElementById('totalDirectories').textContent = 
          data.data.count.toLocaleString();
      }
    } catch (error) {
      console.error('Failed to load directory count:', error);
      document.getElementById('totalDirectories').textContent = '-';
    }
  },

  setupEventListeners() {
    // Search on Enter key
    document.getElementById('searchInput')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.browseFiles();
      }
    });
    
    // Filter changes
    document.getElementById('extensionFilter')?.addEventListener('change', () => this.browseFiles());
    document.getElementById('sortBy')?.addEventListener('change', () => this.browseFiles());
    document.getElementById('sortDir')?.addEventListener('change', () => this.browseFiles());
    document.getElementById('limitSelect')?.addEventListener('change', () => this.browseFiles());
  },

  async browseFiles(page = 1) {
    try {
      this.showLoading();
      
      const search = document.getElementById('searchInput').value;
      const ext = document.getElementById('extensionFilter').value;
      const sortBy = document.getElementById('sortBy').value;
      const sortDir = document.getElementById('sortDir').value;
      const limit = parseInt(document.getElementById('limitSelect').value);

      const params = new URLSearchParams({
        sortBy,
        sortDir,
        page,
        limit
      });

      if (search) params.append('search', search);
      if (ext) params.append('ext', ext);

      const response = await fetch(`/api/v1/files/browse?${params}`);
      const data = await response.json();
      
      if (data.status === 'success') {
        this.displayFiles(data.data);
        this.currentPage = page;
      }
    } catch (error) {
      console.error('Failed to browse files:', error);
      this.showError('Failed to load files');
    } finally {
      this.hideLoading();
    }
  },

  displayFiles(data) {
    const tbody = document.getElementById('filesTableBody');
    const resultsTitle = document.getElementById('resultsTitle');
    const resultsInfo = document.getElementById('resultsInfo');
    
    if (!data || !data.files) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">No data</td></tr>';
      return;
    }

    resultsTitle.textContent = `Files (${data.pagination.total.toLocaleString()} total)`;
    
    // Update results info
    const { page, limit, total } = data.pagination;
    const start = (page - 1) * limit + 1;
    const end = Math.min(page * limit, total);
    resultsInfo.textContent = `Showing ${start}-${end} of ${total.toLocaleString()} files`;

    if (data.files.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="text-center text-muted py-4">No files found</td>
        </tr>
      `;
      this.renderPagination(data.pagination, 'paginationTop');
      this.renderPagination(data.pagination, 'paginationBottom');
      return;
    }

    tbody.innerHTML = data.files.map(file => {
      const fileIcon = this.getFileIcon(file.ext);
      return `
        <tr class="file-item">
          <td class="text-center">
            <i class="fas ${fileIcon} text-muted"></i>
          </td>
          <td>
            <strong>${this.escapeHtml(file.filename)}</strong>
            <br>
            <small class="text-muted">${this.escapeHtml(file.dirname)}</small>
          </td>
          <td>${formatFileSize(file.size)}</td>
          <td>
            <small>${formatDate(new Date(file.mtime * 1000))}</small>
          </td>
          <td>
            <button class="btn btn-sm btn-outline-primary" onclick="FileBrowser.showFileDetails('${this.escapeHtml(file.dirname)}', '${this.escapeHtml(file.filename)}')">
              <i class="fa fa-info-circle"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    this.renderPagination(data.pagination, 'paginationTop');
    this.renderPagination(data.pagination, 'paginationBottom');
  },

  renderPagination(pagination, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const { page, pages, total } = pagination;
    
    let html = '<nav><ul class="pagination pagination-sm mb-0">';
    
    // Previous button
    html += `
      <li class="page-item ${page === 1 ? 'disabled' : ''}">
        <a class="page-link" href="#" onclick="FileBrowser.browseFiles(${page - 1}); return false;">
          <i class="fa fa-chevron-left"></i>
        </a>
      </li>
    `;
    
    // Page numbers (show max 5)
    let startPage = Math.max(1, page - 2);
    let endPage = Math.min(pages, page + 2);
    
    if (startPage > 1) {
      html += `<li class="page-item"><a class="page-link" href="#" onclick="FileBrowser.browseFiles(1); return false;">1</a></li>`;
      if (startPage > 2) {
        html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
      }
    }
    
    for (let i = startPage; i <= endPage; i++) {
      html += `
        <li class="page-item ${i === page ? 'active' : ''}">
          <a class="page-link" href="#" onclick="FileBrowser.browseFiles(${i}); return false;">${i}</a>
        </li>
      `;
    }
    
    if (endPage < pages) {
      if (endPage < pages - 1) {
        html += `<li class="page-item disabled"><span class="page-link">...</span></li>`;
      }
      html += `<li class="page-item"><a class="page-link" href="#" onclick="FileBrowser.browseFiles(${pages}); return false;">${pages}</a></li>`;
    }
    
    // Next button
    html += `
      <li class="page-item ${page === pages ? 'disabled' : ''}">
        <a class="page-link" href="#" onclick="FileBrowser.browseFiles(${page + 1}); return false;">
          <i class="fa fa-chevron-right"></i>
        </a>
      </li>
    `;
    
    html += '</ul></nav>';
    
    container.innerHTML = html;
  },

  getFileTypeClass(ext) {
    if (!ext) return 'other';
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg'];
    const videoExts = ['mp4', 'avi', 'mkv', 'mov', 'wmv'];
    const audioExts = ['mp3', 'wav', 'flac', 'aac'];
    const docExts = ['pdf', 'doc', 'docx', 'txt', 'rtf'];
    
    if (imageExts.includes(ext.toLowerCase())) return 'img';
    if (videoExts.includes(ext.toLowerCase())) return 'vid';
    if (audioExts.includes(ext.toLowerCase())) return 'aud';
    if (docExts.includes(ext.toLowerCase())) return 'doc';
    return 'other';
  },

  getFileIcon(ext) {
    if (!ext) return 'fa-file';
    
    const lowerExt = ext.toLowerCase();
    
    // Images
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(lowerExt)) {
      return 'fa-file-image';
    }
    
    // Videos
    if (['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm'].includes(lowerExt)) {
      return 'fa-file-video';
    }
    
    // Audio
    if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(lowerExt)) {
      return 'fa-file-audio';
    }
    
    // Documents
    if (['pdf'].includes(lowerExt)) {
      return 'fa-file-pdf';
    }
    if (['doc', 'docx'].includes(lowerExt)) {
      return 'fa-file-word';
    }
    if (['xls', 'xlsx'].includes(lowerExt)) {
      return 'fa-file-excel';
    }
    if (['ppt', 'pptx'].includes(lowerExt)) {
      return 'fa-file-powerpoint';
    }
    if (['txt', 'log'].includes(lowerExt)) {
      return 'fa-file-alt';
    }
    
    // Archives
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(lowerExt)) {
      return 'fa-file-archive';
    }
    
    // Code
    if (['js', 'py', 'java', 'cpp', 'c', 'html', 'css', 'php', 'json', 'xml'].includes(lowerExt)) {
      return 'fa-file-code';
    }
    
    return 'fa-file';
  },

  showFileDetails(dirname, filename) {
    const modalBody = document.getElementById('fileDetailsBody');
    const fullPath = dirname + filename;
    
    modalBody.innerHTML = `
      <div class="row">
        <div class="col-md-4"><strong>Name:</strong></div>
        <div class="col-md-8">${this.escapeHtml(filename)}</div>
      </div>
      <div class="row mt-2">
        <div class="col-md-4"><strong>Location:</strong></div>
        <div class="col-md-8"><code>${this.escapeHtml(dirname)}</code></div>
      </div>
      <div class="row mt-2">
        <div class="col-md-4"><strong>Full Path:</strong></div>
        <div class="col-md-8"><code>${this.escapeHtml(fullPath)}</code></div>
      </div>
    `;
    
    const modal = new bootstrap.Modal(document.getElementById('fileDetailsModal'));
    modal.show();
  },

  showLoading() {
    document.getElementById('loadingOverlay').style.display = 'flex';
  },

  hideLoading() {
    document.getElementById('loadingOverlay').style.display = 'none';
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  showError(message) {
    // Simple alert for now - could be enhanced with toast notifications
    alert(message);
  }
};

// Global functions for onclick handlers
window.performSearch = () => FileBrowser.browseFiles();
window.browseFiles = () => FileBrowser.browseFiles();
window.clearFilters = () => {
  document.getElementById('searchInput').value = '';
  document.getElementById('extensionFilter').value = '';
  document.getElementById('sortBy').value = 'filename';
  document.getElementById('sortDir').value = 'asc';
  FileBrowser.browseFiles();
};

// Make FileBrowser available globally for onclick handlers
window.FileBrowser = FileBrowser;

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  FileBrowser.init();
});

export default FileBrowser;
