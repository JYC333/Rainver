/**
 * arXiv category taxonomy.
 *
 * Source: https://arxiv.org/category_taxonomy
 * Checked: 2026-07-03.
 */
interface ArxivCategoryOption {
  value: string;
  label: string;
}

interface ArxivCategoryGroup {
  group: string;
  options: readonly ArxivCategoryOption[];
}

export const ARXIV_CATEGORY_GROUPS: readonly ArxivCategoryGroup[] = [
  {
    group: "Computer Science",
    options: [
      { value: "cs.AI", label: "Artificial Intelligence" },
      { value: "cs.AR", label: "Hardware Architecture" },
      { value: "cs.CC", label: "Computational Complexity" },
      { value: "cs.CE", label: "Computational Engineering, Finance, and Science" },
      { value: "cs.CG", label: "Computational Geometry" },
      { value: "cs.CL", label: "Computation and Language" },
      { value: "cs.CR", label: "Cryptography and Security" },
      { value: "cs.CV", label: "Computer Vision and Pattern Recognition" },
      { value: "cs.CY", label: "Computers and Society" },
      { value: "cs.DB", label: "Databases" },
      { value: "cs.DC", label: "Distributed, Parallel, and Cluster Computing" },
      { value: "cs.DL", label: "Digital Libraries" },
      { value: "cs.DM", label: "Discrete Mathematics" },
      { value: "cs.DS", label: "Data Structures and Algorithms" },
      { value: "cs.ET", label: "Emerging Technologies" },
      { value: "cs.FL", label: "Formal Languages and Automata Theory" },
      { value: "cs.GL", label: "General Literature" },
      { value: "cs.GR", label: "Graphics" },
      { value: "cs.GT", label: "Computer Science and Game Theory" },
      { value: "cs.HC", label: "Human-Computer Interaction" },
      { value: "cs.IR", label: "Information Retrieval" },
      { value: "cs.IT", label: "Information Theory" },
      { value: "cs.LG", label: "Machine Learning" },
      { value: "cs.LO", label: "Logic in Computer Science" },
      { value: "cs.MA", label: "Multiagent Systems" },
      { value: "cs.MM", label: "Multimedia" },
      { value: "cs.MS", label: "Mathematical Software" },
      { value: "cs.NA", label: "Numerical Analysis" },
      { value: "cs.NE", label: "Neural and Evolutionary Computing" },
      { value: "cs.NI", label: "Networking and Internet Architecture" },
      { value: "cs.OH", label: "Other Computer Science" },
      { value: "cs.OS", label: "Operating Systems" },
      { value: "cs.PF", label: "Performance" },
      { value: "cs.PL", label: "Programming Languages" },
      { value: "cs.RO", label: "Robotics" },
      { value: "cs.SC", label: "Symbolic Computation" },
      { value: "cs.SD", label: "Sound" },
      { value: "cs.SE", label: "Software Engineering" },
      { value: "cs.SI", label: "Social and Information Networks" },
      { value: "cs.SY", label: "Systems and Control" },
    ],
  },
  {
    group: "Economics",
    options: [
      { value: "econ.EM", label: "Econometrics" },
      { value: "econ.GN", label: "General Economics" },
      { value: "econ.TH", label: "Theoretical Economics" },
    ],
  },
  {
    group: "Electrical Engineering and Systems Science",
    options: [
      { value: "eess.AS", label: "Audio and Speech Processing" },
      { value: "eess.IV", label: "Image and Video Processing" },
      { value: "eess.SP", label: "Signal Processing" },
      { value: "eess.SY", label: "Systems and Control" },
    ],
  },
  {
    group: "Mathematics",
    options: [
      { value: "math.AC", label: "Commutative Algebra" },
      { value: "math.AG", label: "Algebraic Geometry" },
      { value: "math.AP", label: "Analysis of PDEs" },
      { value: "math.AT", label: "Algebraic Topology" },
      { value: "math.CA", label: "Classical Analysis and ODEs" },
      { value: "math.CO", label: "Combinatorics" },
      { value: "math.CT", label: "Category Theory" },
      { value: "math.CV", label: "Complex Variables" },
      { value: "math.DG", label: "Differential Geometry" },
      { value: "math.DS", label: "Dynamical Systems" },
      { value: "math.FA", label: "Functional Analysis" },
      { value: "math.GM", label: "General Mathematics" },
      { value: "math.GN", label: "General Topology" },
      { value: "math.GR", label: "Group Theory" },
      { value: "math.GT", label: "Geometric Topology" },
      { value: "math.HO", label: "History and Overview" },
      { value: "math.IT", label: "Information Theory" },
      { value: "math.KT", label: "K-Theory and Homology" },
      { value: "math.LO", label: "Logic" },
      { value: "math.MG", label: "Metric Geometry" },
      { value: "math.MP", label: "Mathematical Physics" },
      { value: "math.NA", label: "Numerical Analysis" },
      { value: "math.NT", label: "Number Theory" },
      { value: "math.OA", label: "Operator Algebras" },
      { value: "math.OC", label: "Optimization and Control" },
      { value: "math.PR", label: "Probability" },
      { value: "math.QA", label: "Quantum Algebra" },
      { value: "math.RA", label: "Rings and Algebras" },
      { value: "math.RT", label: "Representation Theory" },
      { value: "math.SG", label: "Symplectic Geometry" },
      { value: "math.SP", label: "Spectral Theory" },
      { value: "math.ST", label: "Statistics Theory" },
    ],
  },
  {
    group: "Astrophysics",
    options: [
      { value: "astro-ph.CO", label: "Cosmology and Nongalactic Astrophysics" },
      { value: "astro-ph.EP", label: "Earth and Planetary Astrophysics" },
      { value: "astro-ph.GA", label: "Astrophysics of Galaxies" },
      { value: "astro-ph.HE", label: "High Energy Astrophysical Phenomena" },
      { value: "astro-ph.IM", label: "Instrumentation and Methods for Astrophysics" },
      { value: "astro-ph.SR", label: "Solar and Stellar Astrophysics" },
    ],
  },
  {
    group: "Condensed Matter",
    options: [
      { value: "cond-mat.dis-nn", label: "Disordered Systems and Neural Networks" },
      { value: "cond-mat.mes-hall", label: "Mesoscale and Nanoscale Physics" },
      { value: "cond-mat.mtrl-sci", label: "Materials Science" },
      { value: "cond-mat.other", label: "Other Condensed Matter" },
      { value: "cond-mat.quant-gas", label: "Quantum Gases" },
      { value: "cond-mat.soft", label: "Soft Condensed Matter" },
      { value: "cond-mat.stat-mech", label: "Statistical Mechanics" },
      { value: "cond-mat.str-el", label: "Strongly Correlated Electrons" },
      { value: "cond-mat.supr-con", label: "Superconductivity" },
    ],
  },
  {
    group: "General Relativity and Quantum Cosmology",
    options: [
      { value: "gr-qc", label: "General Relativity and Quantum Cosmology" },
    ],
  },
  {
    group: "High Energy Physics",
    options: [
      { value: "hep-ex", label: "High Energy Physics - Experiment" },
      { value: "hep-lat", label: "High Energy Physics - Lattice" },
      { value: "hep-ph", label: "High Energy Physics - Phenomenology" },
      { value: "hep-th", label: "High Energy Physics - Theory" },
    ],
  },
  {
    group: "Mathematical Physics",
    options: [
      { value: "math-ph", label: "Mathematical Physics" },
    ],
  },
  {
    group: "Nonlinear Sciences",
    options: [
      { value: "nlin.AO", label: "Adaptation and Self-Organizing Systems" },
      { value: "nlin.CD", label: "Chaotic Dynamics" },
      { value: "nlin.CG", label: "Cellular Automata and Lattice Gases" },
      { value: "nlin.PS", label: "Pattern Formation and Solitons" },
      { value: "nlin.SI", label: "Exactly Solvable and Integrable Systems" },
    ],
  },
  {
    group: "Nuclear Physics",
    options: [
      { value: "nucl-ex", label: "Nuclear Experiment" },
      { value: "nucl-th", label: "Nuclear Theory" },
    ],
  },
  {
    group: "Physics",
    options: [
      { value: "physics.acc-ph", label: "Accelerator Physics" },
      { value: "physics.ao-ph", label: "Atmospheric and Oceanic Physics" },
      { value: "physics.app-ph", label: "Applied Physics" },
      { value: "physics.atm-clus", label: "Atomic and Molecular Clusters" },
      { value: "physics.atom-ph", label: "Atomic Physics" },
      { value: "physics.bio-ph", label: "Biological Physics" },
      { value: "physics.chem-ph", label: "Chemical Physics" },
      { value: "physics.class-ph", label: "Classical Physics" },
      { value: "physics.comp-ph", label: "Computational Physics" },
      { value: "physics.data-an", label: "Data Analysis, Statistics and Probability" },
      { value: "physics.ed-ph", label: "Physics Education" },
      { value: "physics.flu-dyn", label: "Fluid Dynamics" },
      { value: "physics.gen-ph", label: "General Physics" },
      { value: "physics.geo-ph", label: "Geophysics" },
      { value: "physics.hist-ph", label: "History and Philosophy of Physics" },
      { value: "physics.ins-det", label: "Instrumentation and Detectors" },
      { value: "physics.med-ph", label: "Medical Physics" },
      { value: "physics.optics", label: "Optics" },
      { value: "physics.plasm-ph", label: "Plasma Physics" },
      { value: "physics.pop-ph", label: "Popular Physics" },
      { value: "physics.soc-ph", label: "Physics and Society" },
      { value: "physics.space-ph", label: "Space Physics" },
    ],
  },
  {
    group: "Quantum Physics",
    options: [
      { value: "quant-ph", label: "Quantum Physics" },
    ],
  },
  {
    group: "Quantitative Biology",
    options: [
      { value: "q-bio.BM", label: "Biomolecules" },
      { value: "q-bio.CB", label: "Cell Behavior" },
      { value: "q-bio.GN", label: "Genomics" },
      { value: "q-bio.MN", label: "Molecular Networks" },
      { value: "q-bio.NC", label: "Neurons and Cognition" },
      { value: "q-bio.OT", label: "Other Quantitative Biology" },
      { value: "q-bio.PE", label: "Populations and Evolution" },
      { value: "q-bio.QM", label: "Quantitative Methods" },
      { value: "q-bio.SC", label: "Subcellular Processes" },
      { value: "q-bio.TO", label: "Tissues and Organs" },
    ],
  },
  {
    group: "Quantitative Finance",
    options: [
      { value: "q-fin.CP", label: "Computational Finance" },
      { value: "q-fin.EC", label: "Economics" },
      { value: "q-fin.GN", label: "General Finance" },
      { value: "q-fin.MF", label: "Mathematical Finance" },
      { value: "q-fin.PM", label: "Portfolio Management" },
      { value: "q-fin.PR", label: "Pricing of Securities" },
      { value: "q-fin.RM", label: "Risk Management" },
      { value: "q-fin.ST", label: "Statistical Finance" },
      { value: "q-fin.TR", label: "Trading and Market Microstructure" },
    ],
  },
  {
    group: "Statistics",
    options: [
      { value: "stat.AP", label: "Applications" },
      { value: "stat.CO", label: "Computation" },
      { value: "stat.ME", label: "Methodology" },
      { value: "stat.ML", label: "Machine Learning" },
      { value: "stat.OT", label: "Other Statistics" },
      { value: "stat.TH", label: "Statistics Theory" },
    ],
  },
];

const ARXIV_CATEGORY_IDS: readonly string[] = ARXIV_CATEGORY_GROUPS.flatMap((group) =>
  group.options.map((option) => option.value),
);

export const ARXIV_CATEGORY_ID_SET: ReadonlySet<string> = new Set(ARXIV_CATEGORY_IDS);
