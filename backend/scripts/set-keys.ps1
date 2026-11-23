# 安全写入密钥到 backend/.env（已在 .gitignore 中）
# - 输入时不回显，密钥不会出现在命令历史、终端输出或聊天记录里
# - 直接回车表示保留原值；文件以无 BOM 的 UTF-8 写入
# 用法（在项目根目录或任意位置）：powershell -ExecutionPolicy Bypass -File backend\scripts\set-keys.ps1

$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
$values = [ordered]@{}
if (Test-Path $envFile) {
    foreach ($line in [IO.File]::ReadAllLines($envFile)) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $values[$Matches[1]] = $Matches[2] }
    }
}

function Read-Secret([string]$name, [string]$label) {
    $secure = Read-Host -AsSecureString "$label（$name，回车保留原值）"
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    if ($plain) { $script:values[$name] = $plain.Trim() }
}

function Read-Plain([string]$name, [string]$label) {
    $current = $script:values[$name]
    $hint = if ($current) { "当前 $current，回车保留" } else { '回车跳过' }
    $plain = Read-Host "$label（$name，$hint）"
    if ($plain) { $script:values[$name] = $plain.Trim() }
}

# 端点地址（非机密，明文输入）
Read-Plain 'LLM_BASE_URL' '研究模型 OpenAI 兼容端点'
Read-Plain 'JUDGE_BASE_URL' '评委模型 OpenAI 兼容端点'

Read-Secret 'LLM_API_KEY' '研究模型 API Key'
Read-Secret 'JUDGE_API_KEY' '评委模型 API Key'
Read-Secret 'TAVILY_API_KEY' 'Tavily API Key'
Read-Secret 'EXA_API_KEY' 'Exa API Key'

$lines = foreach ($k in $values.Keys) { "$k=$($values[$k])" }
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
Write-Host ''
foreach ($k in 'LLM_BASE_URL', 'LLM_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'JUDGE_BASE_URL', 'JUDGE_API_KEY') {
    $state = if ($values[$k]) { '已设置' } else { '未设置' }
    Write-Host ("{0,-16} {1}" -f $k, $state)
}
Write-Host "已写入 $envFile"
