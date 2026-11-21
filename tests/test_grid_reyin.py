import sys
sys.path.insert(0, r"F:\retex_core")

if __name__ == "__main__":
    from retex_core import grid as G, quantize as Q

    for sid in [
        "Reyin_Not_Myself_Now_Visualizer_fcb5bb",
        "Darci_Code_Red_Skeler_Vision_Official_978974",
        "Everything_is_Right_ft_Devilish_Trio_7bdaaf",
    ]:
        print(f"\n==================== {sid} ====================")
        g = G.build_verified_grid(sid)
        a = g["audit"]
        print(f"  mode={g['mode']} | bpm={g['bpm']} | bpb={g['bpb']} | downbeat_offset={g['downbeat_offset']} | beats={len(g['beats'])}")
        print(f"  RAW BeatThis:  median={a['raw_median_offset_ms']} ms | max={a['raw_max_offset_ms']} ms")
        print(f"  Re-Tex u_marks: signed_median={a['retex_user_marks_offset_ms']} ms")
        print(f"  VERIFIED grid: status={a['status']} | median={a['median_offset_ms']} ms | max={a['max_offset_ms']} ms | drift={a['drift_pct']}% (straight_err={a['max_straight_err_ms']} ms) | needs_quantize={a['needs_quantize']}")
        print(f"  Note: {a['note']}")
        # Show worst 5 active sections
        act = sorted([s for s in a["sections"] if s["active"]], key=lambda x: -abs(x["offset_ms"]))
        print("  Worst 5 active sections:", [(f"{s['t0']}-{s['t1']}s", f"bpm={s['bpm']}", f"off={s['offset_ms']:+.1f}ms") for s in act[:5]])

    # Now QUANTIZE Reyin and check the POST-QUANTIZE VERIFIED DRUM HIT ACCURACY!!
    print("\n==================== QUANTIZING REYIN ====================")
    gq = Q.quantize_song("Reyin_Not_Myself_Now_Visualizer_fcb5bb", progress=lambda f, m="": print(f"  [{int(f*100):3d}%] {m}"))
    qa = gq["quantized"]["audit"]
    print(f"  QUANTIZED Reyin: rev={gq['quantized']['rev']} | q_bpm={gq['quantized']['bpm']} | t0={gq['quantized']['t0']}")
    print(f"  POST-QUANTIZE AUDIT: status={qa['status']} | median={qa['median_offset_ms']} ms | max={qa['max_offset_ms']} ms | bad_windows={qa['bad_windows']} | drift={qa['drift_pct']}%")
    print(f"  Note: {qa['note']}")
    act_q = sorted([s for s in qa["sections"] if s["active"]], key=lambda x: -abs(x["offset_ms"]))
    print("  Worst 5 quantized sections:", [(f"{s['t0']}-{s['t1']}s", f"bpm={s['bpm']}", f"off={s['offset_ms']:+.1f}ms") for s in act_q[:5]])
