const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const CONFIG_FILE = path.join(__dirname, 'git-monitor-config.json');
const SECRETS_FILE = path.join(__dirname, 'secrets.json');
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'memory', 'git-daily-report.md');
const STATE_FILE = path.join(__dirname, '.git-monitor-state.json');

// 默认配置
let config = {
  repos: [],
  outputFile: DEFAULT_OUTPUT,
  versionDocDir: null,
  modelApiKey: null,
  apiBaseUrl: 'api.minimax.chat', // 支持国内: api.minimaxi.com
  ignorePatterns: ['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv'],
  sensitivePatterns: ['.env', '.key', '.pem', 'password', 'secret', 'token', '.credentials'],
  requireConventionalCommits: true,
  enableDashboard: true,
  dashboardOutput: null
};

// 加载配置文件
if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
  } catch (e) {
    console.error('❌ 配置文件解析失败:', e.message);
  }
}

// 加载密钥文件
if (fs.existsSync(SECRETS_FILE)) {
  try {
    const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
    if (secrets.modelApiKey) config.modelApiKey = secrets.modelApiKey;
    if (secrets.apiBaseUrl) config.apiBaseUrl = secrets.apiBaseUrl;
  } catch (e) {
    console.error('❌ 密钥文件解析失败:', e.message);
  }
}

// 确保输出目录存在
const outputDir = path.dirname(config.outputFile);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

if (config.versionDocDir && !fs.existsSync(config.versionDocDir)) {
  fs.mkdirSync(config.versionDocDir, { recursive: true });
}

if (config.enableDashboard) {
  config.dashboardOutput = config.dashboardOutput || path.join(__dirname, '..', 'memory', 'git-dashboard.html');
  const dashboardDir = path.dirname(config.dashboardOutput);
  if (!fs.existsSync(dashboardDir)) {
    fs.mkdirSync(dashboardDir, { recursive: true });
  }
}

// ============ 状态管理 (用于增量 diff) ============
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch (e) {}
  }
  return { repos: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ============ 工具函数 ============
function isIgnored(filePath, ignorePatterns) {
  const parts = filePath.split(/[/\\]/);
  for (const part of parts) {
    if (ignorePatterns.includes(part)) return true;
  }
  return false;
}

function checkSensitiveFiles(files, patterns) {
  const sensitive = [];
  for (const file of files) {
    const lowerFile = file.toLowerCase();
    for (const pattern of patterns) {
      if (lowerFile.includes(pattern.toLowerCase())) {
        sensitive.push(file);
        break;
      }
    }
  }
  return sensitive;
}

function validateConventionalCommit(message) {
  const patterns = [
    /^feat(\(.+\))?: .+/,           // feat: 新功能
    /^fix(\(.+\))?: .+/,            // fix: 修复
    /^docs(\(.+\))?: .+/,           // docs: 文档
    /^style(\(.+\))?: .+/,          // style: 格式
    /^refactor(\(.+\))?: .+/,       // refactor: 重构
    /^perf(\(.+\))?: .+/,           // perf: 性能
    /^test(\(.+\))?: .+/,           // test: 测试
    /^chore(\(.+\))?: .+/,          // chore: 杂项
    /^BREAKING CHANGE: .+/          // 破坏性变更
  ];
  return patterns.some(p => p.test(message));
}

function getCodeStats(repoPath) {
  try {
    const result = execSync('git diff --stat HEAD', { cwd: repoPath, encoding: 'utf-8' });
    const lines = result.trim().split('\n');
    const stats = { files: 0, insertions: 0, deletions: 0 };
    
    for (const line of lines) {
      const match = line.match(/(\d+)\s+(\d+)\s+(\d+)/);
      if (match) {
        stats.files += 1;
        stats.insertions += parseInt(match[2]);
        stats.deletions += parseInt(match[3]);
      }
    }
    return stats;
  } catch (e) {
    return { files: 0, insertions: 0, deletions: 0 };
  }
}

// ============ 核心功能 ============
function getGitChanges(repoPath) {
  const repoName = path.basename(repoPath);
  const state = loadState();
  const repoState = state.repos[repoPath] || { lastCommitHash: null };
  
  try {
    // 验证仓库路径
    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      return { repoName, repoPath, error: '不是有效的 Git 仓库' };
    }

    // 获取当前分支
    const branch = execSync('git branch --show-current', { 
      cwd: repoPath, 
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    // 获取今日提交 (使用更安全的解析方式)
    const today = new Date().toISOString().split('T')[0];
    const todayCommitsRaw = execSync(`git log --since="${today}" --pretty=format:"COMMIT_START%n%h%n%s%n%ai%n%anCOMMIT_END"`, { 
      cwd: repoPath, 
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const todayCommits = [];
    if (todayCommitsRaw) {
      const commits = todayCommitsRaw.split('COMMIT_END');
      for (const commit of commits) {
        const parts = commit.trim().split('\n');
        if (parts.length >= 4 && parts[0] === 'COMMIT_START') {
          todayCommits.push({
            hash: parts[1],
            message: parts[2],
            date: parts[3],
            author: parts[4] || ''
          });
        }
      }
    }

    // 获取所有 commit (用于对比)
    const allCommitsRaw = execSync(`git log -10 --pretty=format:"COMMIT_START%n%h%n%s%n%aiCOMMIT_END"`, { 
      cwd: repoPath, 
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const allCommits = [];
    if (allCommitsRaw) {
      const commits = allCommitsRaw.split('COMMIT_END');
      for (const commit of commits) {
        const parts = commit.trim().split('\n');
        if (parts.length >= 3 && parts[0] === 'COMMIT_START') {
          allCommits.push({
            hash: parts[1],
            message: parts[2].replace(/^COMMIT_START\n/, ''),
            date: parts[3] || ''
          });
        }
      }
    }

    // 获取未提交的更改 (过滤忽略目录)
    let uncommitted = [];
    try {
      const status = execSync('git status --porcelain', { 
        cwd: repoPath, 
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      if (status) {
        const lines = status.split('\n').filter(line => line.trim());
        for (const line of lines) {
          const statusCode = line.substring(0, 2).trim();
          const filePath = line.substring(3).trim();
          
          // 跳过忽略的目录
          if (isIgnored(filePath, config.ignorePatterns)) continue;
          
          uncommitted.push({ status: statusCode, file: filePath });
        }
      }
    } catch (e) {}

    // 获取版本对比 diff
    let diffContent = '';
    if (allCommits.length >= 2) {
      const newCommit = allCommits[0].hash;
      const oldCommit = allCommits[1].hash;
      try {
        diffContent = execSync(`git diff ${oldCommit}..${newCommit} --unified=3`, { 
          cwd: repoPath, 
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
      } catch (e) {}
    }

    // 增量 diff (只分析新提交)
    let incrementalDiff = '';
    if (repoState.lastCommitHash && allCommits.length > 0) {
      const latestHash = allCommits[0].hash;
      if (latestHash !== repoState.lastCommitHash) {
        try {
          incrementalDiff = execSync(`git diff ${repoState.lastCommitHash}..${latestHash} --unified=3`, { 
            cwd: repoPath, 
            encoding: 'utf-8',
            maxBuffer: 5 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();
        } catch (e) {}
      }
    }

    // 检测敏感文件
    const allFiles = [...uncommitted.map(u => u.file)];
    const sensitiveFiles = checkSensitiveFiles(allFiles, config.sensitivePatterns);

    // 代码统计
    const codeStats = getCodeStats(repoPath);

    // 检查 commit message 规范
    const commitValidation = [];
    for (const commit of todayCommits) {
      const isValid = validateConventionalCommit(commit.message);
      commitValidation.push({ hash: commit.hash, message: commit.message, valid: isValid });
    }

    // 更新状态
    if (allCommits.length > 0) {
      state.repos[repoPath] = { lastCommitHash: allCommits[0].hash };
      saveState(state);
    }

    return {
      repoName,
      repoPath,
      branch,
      todayCommits,
      allCommits,
      uncommitted,
      diffContent,
      incrementalDiff,
      sensitiveFiles,
      codeStats,
      commitValidation,
      newCommitsCount: repoState.lastCommitHash ? 
        allCommits.findIndex(c => c.hash === repoState.lastCommitHash) : allCommits.length
    };
  } catch (error) {
    return {
      repoName,
      repoPath,
      error: error.message
    };
  }
}

// 使用 AI 分析代码变化
async function analyzeChangesWithAI(diffContent, commits) {
  if (!diffContent || diffContent.length < 10) {
    return null;
  }

  const truncatedDiff = diffContent.length > 8000 ? diffContent.substring(0, 8000) + '\n...(truncated)' : diffContent;

  const prompt = `Analyze this git diff. What files changed and what was the purpose? Keep it brief.

Diff:
${truncatedDiff}`;

  const apiKey = config.modelApiKey;
  if (!apiKey) {
    console.log('⚠️ 未配置 MiniMax API Key，跳过 AI 分析');
    return null;
  }
  
  const model = 'MiniMax-M2.5';
  
  const requestData = {
    model: model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 2048
  };

  return new Promise((resolve) => {
    const data = JSON.stringify(requestData);
    
    const options = {
      hostname: config.apiBaseUrl,
      path: '/v1/text/chatcompletion_v2',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.choices && result.choices[0]) {
            resolve(result.choices[0].message.content);
          } else if (result.base_resp) {
            console.log('❌ API 错误:', result.base_resp.status_msg);
            resolve(null);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.log('❌ API 请求失败:', e.message);
      resolve(null);
    });
    req.write(data);
    req.end();
  });
}

// 分析文件变化类型
function analyzeChanges(uncommitted) {
  const changes = { added: [], modified: [], deleted: [], renamed: [] };
  
  for (const item of uncommitted) {
    const status = item.status;
    const file = item.file;
    
    if (status.includes('A') || status === 'A') {
      changes.added.push(file);
    } else if (status.includes('D') || status === 'D') {
      changes.deleted.push(file);
    } else if (status.includes('R') || status === 'R') {
      changes.renamed.push(file);
    } else {
      changes.modified.push(file);
    }
  }
  
  return changes;
}

// 生成版本更新文档
async function generateVersionDoc(repoPath, result) {
  if (!config.versionDocDir) return null;
  
  const changes = analyzeChanges(result.uncommitted);
  const now = new Date();
  const version = now.toISOString().split('T')[0].replace(/-/g, '');
  const timestamp = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '');
  
  if (result.todayCommits.length === 0 && result.uncommitted.length === 0) {
    return null;
  }

  let aiAnalysis = '';
  if (result.diffContent) {
    console.log('🤖 正在使用 AI 分析代码变化...');
    aiAnalysis = await analyzeChangesWithAI(result.diffContent, result.allCommits);
    if (aiAnalysis) console.log('✅ AI 分析完成');
  }

  // 构建内容 (英文 + 中文)
  let content = `# Version Update Document

## Version: ${version}
Generated: ${timestamp}

---

### Summary

`;

  if (result.todayCommits.length > 0) {
    content += `#### 📥 Today's Commits (${result.todayCommits.length})\n\n`;
    for (const commit of result.todayCommits) {
      content += `- **${commit.hash}**: ${commit.message}\n`;
      content += `  - Author: ${commit.author}\n`;
      content += `  - Date: ${commit.date}\n\n`;
    }
  }

  if (result.uncommitted.length > 0) {
    content += `#### ⚠️ Uncommitted Changes (${result.uncommitted.length})\n\n`;
    if (changes.added.length > 0) {
      content += `**Added:** ${changes.added.join(', ')}\n`;
    }
    if (changes.modified.length > 0) {
      content += `**Modified:** ${changes.modified.join(', ')}\n`;
    }
    if (changes.deleted.length > 0) {
      content += `**Deleted:** ${changes.deleted.join(', ')}\n`;
    }
    content += '\n';
  }

  if (aiAnalysis) {
    content += `\n### 🤖 AI Analysis\n\n${aiAnalysis}\n`;
  }

  // 中文版本
  let contentCN = content
    .replace('Version Update Document', '版本更新文档')
    .replace('Summary', '概要')
    .replace("Today's Commits", '今日提交')
    .replace('Uncommitted Changes', '未提交的更改')
    .replace('Added', '新增')
    .replace('Modified', '修改')
    .replace('Deleted', '删除')
    .replace('AI Analysis', 'AI 分析')
    .replace('Author', '作者')
    .replace('Date', '日期');

  // 写入文件 (添加时间戳避免覆盖)
  const versionFileEN = path.join(config.versionDocDir, `v${version}_${timeStr}.md`);
  const versionFileCN = path.join(config.versionDocDir, `v${version}_${timeStr}_CN.md`);
  
  fs.writeFileSync(versionFileEN, content, 'utf-8');
  fs.writeFileSync(versionFileCN, contentCN, 'utf-8');
  
  return { version, time: timeStr, en: versionFileEN, cn: versionFileCN };
}

// 生成报告
function generateReport(results) {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  
  let report = `# Git 仓库每日监控报告

> 生成时间: ${now}

---

`;

  if (results.length === 0) {
    report += '未配置监控的仓库。\n';
    return report;
  }

  for (const result of results) {
    report += `## 📁 ${result.repoName}\n`;
    report += `> 路径: ${result.repoPath}\n\n`;

    if (result.error) {
      report += `❌ 错误: ${result.error}\n\n`;
      continue;
    }

    report += `**分支:** ${result.branch}\n`;

    // 统计信息
    if (result.codeStats.files > 0) {
      report += `**代码变化:** +${result.codeStats.insertions} -${result.codeStats.deletions} (${result.codeStats.files} 文件)\n`;
    }
    report += '\n';

    // 今日提交
    if (result.todayCommits.length > 0) {
      report += `### 📝 今日提交 (${result.todayCommits.length} 个)\n`;
      for (const commit of result.todayCommits) {
        report += `- **${commit.hash}**: ${commit.message}\n`;
      }
      report += '\n';
    }

    // Commit 规范检查
    if (config.requireConventionalCommits && result.commitValidation.length > 0) {
      const invalid = result.commitValidation.filter(c => !c.valid);
      if (invalid.length > 0) {
        report += `### ⚠️ Commit 规范问题 (${invalid.length} 个)\n`;
        for (const c of invalid) {
          report += `- ${c.hash}: ${c.message}\n`;
        }
        report += '\n';
      }
    }

    // 敏感文件检测
    if (result.sensitiveFiles && result.sensitiveFiles.length > 0) {
      report += `### 🔒 敏感文件检测 (${result.sensitiveFiles.length} 个)\n`;
      report += '⚠️ 检测到可能包含敏感信息的文件:\n';
      for (const file of result.sensitiveFiles) {
        report += `- ${file}\n`;
      }
      report += '\n';
    }

    // 未提交的更改
    const changes = analyzeChanges(result.uncommitted);
    if (result.uncommitted.length > 0) {
      report += `### ⚠️ 未提交的更改 (${result.uncommitted.length} 个)\n`;
      if (changes.added.length > 0) {
        report += `**新增:** ${changes.added.join(', ')}\n`;
      }
      if (changes.modified.length > 0) {
        report += `**修改:** ${changes.modified.join(', ')}\n`;
      }
      if (changes.deleted.length > 0) {
        report += `**删除:** ${changes.deleted.join(', ')}\n`;
      }
      report += '\n';
    }

    if (result.todayCommits.length === 0 && result.uncommitted.length === 0) {
      report += `### ✅ 今日无变化\n\n`;
    }

    report += '---\n\n';
  }

  return report;
}

// 生成 Web Dashboard
function generateDashboard(results) {
  if (!config.enableDashboard) return null;

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  
  let repoCards = '';
  let totalCommits = 0;
  let totalChanges = { added: 0, modified: 0, deleted: 0 };
  let totalFiles = 0;

  for (const result of results) {
    if (result.error) continue;
    
    totalCommits += result.todayCommits.length;
    totalFiles += result.codeStats.files;
    totalChanges.added += result.codeStats.insertions;
    totalChanges.deleted += result.codeStats.deletions;

    const changes = analyzeChanges(result.uncommitted);
    const uncommittedCount = result.uncommitted.length;
    
    repoCards += `
    <div class="repo-card">
      <h3>📁 ${result.repoName}</h3>
      <p class="branch">🌿 ${result.branch}</p>
      <div class="stats">
        <span class="stat">📝 ${result.todayCommits.length} commits</span>
        <span class="stat">📄 ${uncommittedCount} pending</span>
        <span class="stat">➕ ${result.codeStats.insertions}</span>
        <span class="stat">➖ ${result.codeStats.deletions}</span>
      </div>
      ${result.sensitiveFiles?.length ? `<p class="warning">🔒 敏感文件: ${result.sensitiveFiles.length}</p>` : ''}
    </div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Git Monitor Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
           background: #1a1a2e; color: #eee; min-height: 100vh; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { text-align: center; margin-bottom: 10px; }
    .timestamp { text-align: center; color: #888; margin-bottom: 30px; }
    .overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
                gap: 15px; margin-bottom: 30px; }
    .stat-card { background: #16213e; padding: 20px; border-radius: 10px; text-align: center; }
    .stat-card .value { font-size: 2em; font-weight: bold; color: #4ecca3; }
    .stat-card .label { color: #888; margin-top: 5px; }
    .repos { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; }
    .repo-card { background: #16213e; padding: 20px; border-radius: 10px; }
    .repo-card h3 { margin-bottom: 10px; }
    .repo-card .branch { color: #888; font-size: 0.9em; margin-bottom: 10px; }
    .repo-card .stats { display: flex; flex-wrap: wrap; gap: 10px; }
    .repo-card .stat { background: #0f3460; padding: 5px 10px; border-radius: 5px; font-size: 0.85em; }
    .repo-card .warning { color: #e94560; margin-top: 10px; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔍 Git Monitor Dashboard</h1>
    <p class="timestamp">更新时间: ${now}</p>
    
    <div class="overview">
      <div class="stat-card">
        <div class="value">${results.filter(r => !r.error).length}</div>
        <div class="label">仓库数</div>
      </div>
      <div class="stat-card">
        <div class="value">${totalCommits}</div>
        <div class="label">今日提交</div>
      </div>
      <div class="stat-card">
        <div class="value">+${totalChanges.added}</div>
        <div class="label">新增行</div>
      </div>
      <div class="stat-card">
        <div class="value">-${totalChanges.deleted}</div>
        <div class="label">删除行</div>
      </div>
    </div>

    <div class="repos">
      ${repoCards || '<p>暂无仓库数据</p>'}
    </div>
  </div>
</body>
</html>`;

  fs.writeFileSync(config.dashboardOutput, html, 'utf-8');
  return config.dashboardOutput;
}

// 主程序
async function main() {
  console.log('🔍 开始检查 Git 仓库...\n');
  console.log(`📂 监控仓库数: ${config.repos.length}`);
  console.log(`🔑 API: ${config.apiBaseUrl}\n`);

  const results = config.repos.map(repo => getGitChanges(repo));

  // 生成版本文档
  for (const result of results) {
    if (!result.error && config.versionDocDir) {
      const doc = await generateVersionDoc(result.repoPath, result);
      if (doc) {
        console.log(`📄 版本文档已生成: v${doc.version}_${doc.time}.md`);
      }
    }
  }

  // 生成报告
  const report = generateReport(results);
  fs.writeFileSync(config.outputFile, report, 'utf-8');
  console.log(`\n✅ 报告已生成: ${config.outputFile}`);

  // 生成 Dashboard
  if (config.enableDashboard) {
    const dashboard = generateDashboard(results);
    console.log(`📊 Dashboard: ${dashboard}`);
  }

  console.log(`\n📊 检查了 ${results.length} 个仓库`);
}

main();
