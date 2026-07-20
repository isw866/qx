import urllib.request
import os
import sys
from datetime import datetime
import re

def clean_and_parse_content(content, noise_keywords, mitm_hosts):
    """
    全量地毯式清洗规则内容，无差别抹除所有纯注释行（含 #, ;, //），并精准切除有效规则的行尾注释（绝不误伤正则斜杠）
    """
    sub_rewrite = []
    sub_mitm = []
    current_section = 'rewrite' # 默认当作 rewrite 处理
    
    # 彻底统一换行符，并切割成单行列表
    lines = content.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    
    for raw_line in lines:
        stripped_line = raw_line.strip()
        if not stripped_line:
            continue

        # 1. 识别并切换 Quantumult X 的系统标签
        if stripped_line.lower() == '[rewrite_local]':
            current_section = 'rewrite'
            continue
        elif stripped_line.lower() == '[mitm]':
            current_section = 'mitm'
            continue
        elif stripped_line.startswith('[') and stripped_line.endswith(']'):
            current_section = 'unknown'
            continue

        # 2. 强力防线：只要是纯注释行（支持 #、; 以及双斜杠 //），无差别直接丢弃
        if stripped_line.startswith(';') or stripped_line.startswith('#') or stripped_line.startswith('//'):
            continue

        # 3. 精准切除行尾的行内注释
        # 规则：
        #   - [;#] 后面跟着的属于注释
        #   - 必须是前面带有空格/制表符的 //（即 \s+//），或者是位于行尾的 //，这才叫行内注释。
        #   - 这样可以完美放行类似于 https:// 或 \/\/ 这种紧凑粘连在正则和URL内部的斜杠。
        comment_pattern = r'[;#]|\s+//'
        
        if re.search(comment_pattern, stripped_line):
            # 用正则精准切开规则体与注释体
            parts = re.split(comment_pattern, stripped_line, 1)
            core_part = parts[0].strip()
            if not core_part:
                continue
            stripped_line = core_part
            raw_line = core_part  # 覆盖原有 raw_line，确保写入的是干净的规则

        # 4. 分流归类有效规则
        if current_section == 'rewrite':
            sub_rewrite.append(raw_line)
        elif current_section == 'mitm':
            if 'hostname' in stripped_line:
                try:
                    _, hosts = stripped_line.split('=', 1)
                    for h in hosts.split(','):
                        h_clean = h.strip()
                        # 确保提取出的 hostname 不带任何干扰符号和残余注释
                        if h_clean and not h_clean.startswith(';') and not h_clean.startswith('#') and not h_clean.startswith('//'):
                            # 进一步清洗 hostname 行尾可能夹带的注释
                            h_clean = re.split(comment_pattern, h_clean)[0].strip()
                            mitm_hosts.add(h_clean)
                except Exception:
                    sub_mitm.append(raw_line)
            else:
                sub_mitm.append(raw_line)
                
    return sub_rewrite, sub_mitm

def main():
    list_file = 'rules_list.txt'
    output_file = 'myRewrite.conf'
    
    if not os.path.exists(list_file):
        print(f"错误：未找到 {list_file} 文件！")
        sys.exit(1)

    failed_rules = []
    
    # 将两种类型的规则完全分离开来存放
    total_rewrite_lines = []
    total_mitm_lines = []
    mitm_hosts = set()

    # 保留降噪词库以防未来其他逻辑扩展需要
    noise_keywords = [
        'update', '更新', 'history', '历史', 'changelog', '日志', 
        'tgchannel', 'telegram', '频道', '群组', 'author', '作者', 
        'drew', 'by', 'donation', '赞赏', '打赏', 'github', 'repo',
        'version', '版本', 'date', '时间', 'modified', 'crack', '解锁', 
        '删除', '新增', '移除', '修复', '去除', '去掉', '添加', '屏蔽', 
        '处理', '解决', '墨鱼', 't.me'
    ]

    with open(list_file, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    for line in lines:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        
        try:
            name, url = line.split(',', 1)
            name = name.strip()
            url = url.strip()
        except ValueError:
            print(f"跳过格式错误的行: {line}")
            continue

        print(f"正在下载 [{name}]: {url}")
        
        try:
            headers = {
                'User-Agent': 'Quantumult%20X/1.5.0 (iPhone; iOS 18.2; Scale/3.00)',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            }
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as response:
                content = response.read().decode('utf-8').strip()
                
                if not content:
                    raise Exception("下载内容为空")
                
                if '<html' in content.lower() or '<doctype' in content.lower():
                    raise Exception("被服务器拦截重定向至网页首页")
                
                # 调用深度清洗
                sub_rewrite, sub_mitm = clean_and_parse_content(content, noise_keywords, mitm_hosts)

                # 将重写规则加入各自的板块里，并用注释标明出处
                if sub_rewrite:
                    total_rewrite_lines.append(f"; === 开始: {name} ===")
                    total_rewrite_lines.extend(sub_rewrite)
                    total_rewrite_lines.append(f"; === 结束: {name} ===\n")
                
                # 将可能存在的非 hostname 的 mitm 规则追加到对应的板块
                if sub_mitm:
                    total_mitm_lines.append(f"; === 开始: {name} ===")
                    total_mitm_lines.extend(sub_mitm)
                    total_mitm_lines.append(f"; === 结束: {name} ===\n")
                
        except Exception as e:
            print(f"❌ 规则 [{name}] 下载失败: {str(e)}")
            failed_rules.append(f"{name} ({str(e)})")

    # 开始组装最终的文件内容
    final_content = [
        '; Quantumult X 重写规则集合',
        '; 自动更新于: ' + datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        '; --------------------------------------------------\n',
    ]
    
    # 1. 写入所有的重写规则
    if total_rewrite_lines:
        final_content.append('[rewrite_local]')
        final_content.extend(total_rewrite_lines)
        
    # 2. 写入 MITM 板块（合并去重后的主机名以及可能存在的独立 mitm 规则）
    if mitm_hosts or total_mitm_lines:
        final_content.append('[mitm]')
        if mitm_hosts:
            final_content.append('hostname = ' + ', '.join(sorted(list(mitm_hosts))))
        if total_mitm_lines:
            final_content.extend(total_mitm_lines)

    # 只要生成了任何有效规则，就写入文件
    if total_rewrite_lines or mitm_hosts or total_mitm_lines: 
        with open(output_file, 'w', encoding='utf-8') as out:
            out.write('\n'.join(final_content))

    if failed_rules:
        github_output = os.environ.get('GITHUB_OUTPUT')
        if github_output:
            with open(github_output, 'a', encoding='utf-8') as go:
                go.write('failed=true\n')
                go.write('errors=' + ', '.join(failed_rules) + '\n')

if __name__ == '__main__':
    main()
