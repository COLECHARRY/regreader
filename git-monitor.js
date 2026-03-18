const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const SCRIPT_DIR = __dirname;
const CONFIG_FILE = path.join(SCRIPT_DIR, 'git-monitor-config.json');
const STATE_FILE = path.join(SCRIPT_DIR, '.git-monitor-state.json');

// 加载配置
let config = {
  modelApiKey: '',
  versionDocDir: null
};

if (fs.existsSync(CONFIG_FILE)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
}

// 确保版本目录存在
if (config.versionDocDir && !fs.existsSync(config.versionDocDir)) {
  fs.mkdirSync(config.versionDocDir, { recursive: true });
}

// 加载状态（上次分析的 commit）
let state = {
  lastCommitHash: '',
  lastAnalyzeTime: ''
};

if (fs.existsSync(STATE_FILE)) {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
}

// 获取当前仓库的最新 commit
function getLatestCommit(repoPath) {
  try {
    const hash = execSync('git log -1 --format="%H"', { 
      cwd: repoPath, 
      encoding: 'utf-8' 
    }).trim();
    return hash;
  } catch (e) {
    return null;
  }
}

// 获取两次 commit 之间的差异
function getDiffBetweenCommits(repoPath, oldCommit, newCommit) {
  try {
    const diff = execSync(`git diff ${oldCommit}..${newCommit} --unified=3`, { 
      cwd: repoPath, 
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    }).trim();
    return diff;
  } catch (e) {
    return '';
  }
}

// 获取新提交
function getNewCommits(repoPath, afterCommit) {
  try {
    const commits = execSync(`git log ${afterCommit}..HEAD --pretty=format:"%H|||%s|||%ai|||%an"`, { 
      cwd: repoPath, 
      encoding: 'utf-8' 
    }).trim();
    
    if (!commits) return [];
    
    return commits.split('\n').map(c => {
      const parts = c.split('|||');
      return {
        hash: parts[0],
        message: parts[1],
        date: parts[2],
        author: parts[3]
      };
    }).reverse(); // 从旧到新
  } catch (e) {
    return [];
  }
}

// 获取未提交的更改
function getUncommittedChanges(repoPath) {
  try {
    const status = execSync('git status --porcelain', { 
      cwd: repoPath, 
      encoding: 'utf-8' 
    }).trim();
    
    if (!status) return [];
    
    return status.split('\n').map(line => {
      const statusCode = line.substring(0, 2).trim();
      const filePath = line.substring(3).trim();
      return { status: statusCode, file: filePath };
    });
  } catch (e) {
    return [];
  }
}

// 使用 AI 分析代码变化
async function analyzeChangesWithAI(diffContent, commits) {
  if (!diffContent || diffContent.length < 10) {
    return null;
  }

  const truncatedDiff = diffContent.length > 6000 ? diffContent.substring(0, 6000) + '\n...(truncated)' : diffContent;

  const commitInfo = commits.map(c => `- ${c.hash.substring(0,7)}: ${c.message}`).join('\n');

  const prompt = `Analyze this git diff. What files changed and why? Be concise.

Recent commits:
${commitInfo}

Diff:
${truncatedDiff}`;

  const apiKey = config.modelApiKey;
  if (!apiKey) {
    console.log('⚠️ 未配置 API Key，跳过 AI 分析');
    return null;
  }

  return new Promise((resolve) => {
    const requestData = {
      model: 'MiniMax-M2.5',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2048
    };

    const options = {
      hostname: 'api.minimax.chat',
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

    req.on('error', () => resolve(null));
    req.write(JSON.stringify(requestData));
    req.end();
  });
}

// 生成版本文档
async function generateVersionDoc(repoPath, newCommits, uncommitted, diffContent) {
  if (!config.versionDocDir) return null;
  
  if (newCommits.length === 0 && uncommitted.length === 0) {
    console.log('📝 自上次分析后没有新变化');
    return null;
  }

  const now = new Date();
  const version = now.toISOString().replace(/[-:]/g, '').substring(0, 14); // 精确到分钟
  const timestamp = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  // AI 分析
  let aiAnalysis = '';
  if (diffContent && diffContent.length > 10) {
    console.log('🤖 正在使用 AI 分析代码变化...');
    aiAnalysis = await analyzeChangesWithAI(diffContent, newCommits);
    if (aiAnalysis) {
      console.log('✅ AI 分析完成');
    }
  }

  // 文件变化统计
  const filesChanged = [];
  const addedFiles = [];
  const modifiedFiles = [];
  const deletedFiles = [];

  for (const commit of newCommits) {
    try {
      const files = execSync(`git show --stat --format="" ${commit.hash}`, { 
        cwd: repoPath, 
        encoding: 'utf-8' 
      }).trim().split('\n');
      
      for (const file of files) {
        if (file && !file.includes('files changed')) {
          const cleanFile = file.replace(/^\s+\d+\s+/, '').trim();
          if (cleanFile && !filesChanged.includes(cleanFile)) {
            filesChanged.push(cleanFile);
          }
        }
      }
    } catch (e) {}
  }

  for (const item of uncommitted) {
    const file = item.file;
    const status = item.status;
    
    if (status.includes('A')) {
      if (!addedFiles.includes(file)) addedFiles.push(file);
    } else if (status.includes('D')) {
      if (!deletedFiles.includes(file)) deletedFiles.push(file);
    } else {
      if (!modifiedFiles.includes(file)) modifiedFiles.push(file);
    }
  }

  let content = `# 版本更新文档

## 版本: ${version}
生成时间: ${timestamp}
分析范围: 自上次分析后的变化

---

### 📥 新增提交 (${newCommits.length})

`;

  for (const commit of newCommits) {
    content += `- **${commit.hash.substring(0,7)}**: ${commit.message}\n`;
    content += `  - 作者: ${commit.author} | 日期: ${commit.date}\n\n`;
  }

  if (uncommitted.length > 0) {
    content += `### ⚠️ 未提交的更改 (${uncommitted.length})\n\n`;
    
    if (addedFiles.length > 0) {
      content += `**新增文件:**\n${addedFiles.map(f => `- ${f}`).join('\n')}\n\n`;
    }
    if (modifiedFiles.length > 0) {
      content += `**修改文件:**\n${modifiedFiles.map(f => `- ${f}`).join('\n')}\n\n`;
    }
    if (deletedFiles.length > 0) {
      content += `**删除文件:**\n${deletedFiles.map(f => `- ${f}`).join('\n')}\n\n`;
    }
  }

  if (aiAnalysis) {
    content += `### 🤖 AI 分析\n\n${aiAnalysis}\n\n`;
  }

  if (diffContent) {
    const truncatedDiff = diffContent.length > 3000 
      ? diffContent.substring(0, 3000) + '\n...(diff 过长，已截断)'
      : diffContent;
    content += `### 📝 代码差异\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\`\n`;
  }

  // 写入文件
  const versionFile = path.join(config.versionDocDir, `v${version}.md`).replace(/\\/g, '/');
  fs.writeFileSync(versionFile, content, 'utf-8');
  
  return { version, file: versionFile };
}

// 主程序
async function main() {
  const repoPath = SCRIPT_DIR;
  const repoName = path.basename(repoPath);
  
  console.log(`🔍 检查仓库: ${repoName}\n`);
  console.log(`📍 路径: ${repoPath}\n`);
  
  // 获取最新 commit
  const latestCommit = getLatestCommit(repoPath);
  if (!latestCommit) {
    console.log('❌ 无法获取 Git 提交记录');
    return;
  }
  
  console.log(`📌 最新 commit: ${latestCommit.substring(0, 7)}`);
  console.log(`📌 上次分析的 commit: ${state.lastCommitHash ? state.lastCommitHash.substring(0, 7) : '无'}\n`);
  
  // 检查是否有新变化
  if (state.lastCommitHash === latestCommit) {
    console.log('✅ 自上次分析后没有新提交');
    
    // 仍然检查未提交的更改
    const uncommitted = getUncommittedChanges(repoPath);
    if (uncommitted.length > 0) {
      console.log(`⚠️ 检测到 ${uncommitted.length} 个未提交的更改`);
      
      // 获取 tracked 文件的 diff
      let diffContent = '';
      try {
        diffContent = execSync('git diff', { cwd: repoPath, encoding: 'utf-8', maxBuffer: 5*1024*1024 }).trim();
      } catch (e) {}
      
      // 获取 untracked 文件内容
      let untrackedContent = '';
      for (const item of uncommitted) {
        const isUntracked = item.status.trim() === '??';
        if (isUntracked) {
          const filePath = path.join(repoPath, item.file);
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              const content = fs.readFileSync(filePath, 'utf-8');
              untrackedContent += `\n### New File: ${item.file}\n\n\`\`\`\n${content.substring(0, 2000)}\n\`\`\`\n`;
            }
          }
        }
      }
      
      const fullDiff = (diffContent || 'No tracked file changes') + untrackedContent;
      const doc = await generateVersionDoc(repoPath, [], uncommitted, fullDiff);
      
      if (doc) {
        console.log(`\n📄 版本文档已生成: ${doc.file}`);
      }
    }
    
    console.log('\n✅ 完成，无需更新');
    return;
  }
  
  // 获取新提交
  const newCommits = getNewCommits(repoPath, state.lastCommitHash || '0000000000000000000000000000000000000000');
  console.log(`📝 新增提交: ${newCommits.length} 个\n`);
  
  // 获取差异
  let diffContent = '';
  if (newCommits.length > 0) {
    // 有新提交时，对比上次分析和最新提交之间的差异
    const oldCommit = state.lastCommitHash || newCommits[0]?.hash || 'HEAD~1';
    diffContent = getDiffBetweenCommits(repoPath, oldCommit, latestCommit);
  }
  
  // 如果没有新提交但有未提交的更改，获取未提交的 diff
  console.log('📝 未提交的更改状态:', JSON.stringify(uncommitted));
  if (uncommitted.length > 0) {
    try {
      // 获取 tracked 文件的 diff
      let trackedDiff = '';
      try {
        trackedDiff = execSync('git diff', { cwd: repoPath, encoding: 'utf-8', maxBuffer: 5*1024*1024 }).trim();
      } catch (e) {}
      
      // 获取 untracked 文件内容
      let untrackedContent = '';
      for (const item of uncommitted) {
        const isUntracked = item.status.trim() === '??';
        console.log('📝 检查文件:', item.file, '状态:', item.status, '是否未跟踪:', isUntracked);
        
        if (isUntracked) {
          // 读取新文件内容
          const filePath = path.join(repoPath, item.file);
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              const content = fs.readFileSync(filePath, 'utf-8');
              untrackedContent += `\n### New File: ${item.file}\n\n\`\`\`\n${content.substring(0, 2000)}\n\`\`\`\n`;
            }
          }
        }
      }
      
      console.log('📝 trackedDiff:', trackedDiff ? '有内容' : '空');
      console.log('📝 untrackedContent:', untrackedContent ? '有内容' : '空');
      
      if (trackedDiff || untrackedContent) {
        diffContent = (trackedDiff || 'No tracked file changes') + untrackedContent;
      }
    } catch (e) {
      console.log('❌ 获取 diff 失败:', e.message);
    }
  }
  
  // 未提交的更改
  const uncommitted = getUncommittedChanges(repoPath);
  
  // 生成版本文档
  const doc = await generateVersionDoc(repoPath, newCommits, uncommitted, diffContent);
  
  if (doc) {
    console.log(`\n📄 版本文档已生成: ${doc.file}`);
  }
  
  // 更新状态
  state.lastCommitHash = latestCommit;
  state.lastAnalyzeTime = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  
  console.log('\n✅ 分析完成！');
}

main();
